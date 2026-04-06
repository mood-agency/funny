import { stat, rm, mkdir } from 'fs/promises';
import { join } from 'path';

import { PaisleyPark } from '../../../src/index.js';
import type { StorageConfig, AddOptions } from '../../../src/index.js';
import { llmComplete } from '../config.js';
import { judgeAnswer } from '../eval/judge.js';
import { chunkConversation, type ConversationTurn } from '../extract/chunker.js';
import { extractFactsFromConversation } from '../extract/conversation-to-facts.js';
import type { BenchmarkConfig, QuestionResult } from '../types.js';
import { loadLocomoDataset } from './loader.js';
import type { LocomoConversation } from './types.js';

export interface LocomoRunResult {
  results: QuestionResult[];
  totalFactsCreated: number;
  totalFactsAfterDedup: number;
  totalExtractionTokens: number;
  totalAnswerTokens: number;
  totalEvalTokens: number;
  dbSizeBytes: number;
  durationSeconds: number;
}

const ANSWER_SYSTEM_PROMPT = `You are answering questions about a person's life based on retrieved memory facts. Use ONLY the provided context to answer. If the context doesn't contain enough information, say "I don't have enough information to answer this."

Be concise — answer in 1-3 sentences maximum.`;

export async function runLocomoBenchmark(config: BenchmarkConfig): Promise<LocomoRunResult> {
  const startTime = Date.now();

  console.log('Loading LOCOMO dataset...');
  const dataset = await loadLocomoDataset(config.dataDir);
  console.log(
    `Loaded ${dataset.conversations.length} conversations, ` +
      `${dataset.totalTurns} turns, ${dataset.totalQuestions} questions`,
  );

  await mkdir(config.dbDir, { recursive: true });

  const allResults: QuestionResult[] = [];
  let totalFactsCreated = 0;
  let totalFactsAfterDedup = 0;
  let totalExtractionTokens = 0;
  let totalAnswerTokens = 0;
  let totalEvalTokens = 0;
  let totalDbSize = 0;

  for (let i = 0; i < dataset.conversations.length; i++) {
    const convo = dataset.conversations[i];
    console.log(
      `\n[${i + 1}/${dataset.conversations.length}] Processing conversation ${convo.conversation_id} ` +
        `(${convo.turns.length} turns, ${convo.questions.length} questions)`,
    );

    const dbPath = join(config.dbDir, `locomo-${convo.conversation_id}.db`);

    const ppConfig: StorageConfig = {
      url: `file:${dbPath}`,
      projectId: `locomo-${convo.conversation_id}`,
      projectName: `LOCOMO Conversation ${convo.conversation_id}`,
      // No LLM config — bypasses admission filter
    };

    // Check if we can reuse cached ingestion
    let cacheHit = false;
    if (config.reuseCache) {
      try {
        const dbStat = await stat(dbPath);
        if (dbStat.size > 0) {
          cacheHit = true;
        }
      } catch {
        // DB doesn't exist, will ingest
      }
    }

    if (!cacheHit) {
      // Clean up existing DB for fresh ingestion
      try {
        await rm(dbPath, { force: true });
        await rm(`${dbPath}-journal`, { force: true });
        await rm(`${dbPath}-wal`, { force: true });
        await rm(`${dbPath}-shm`, { force: true });
      } catch {
        // ignore
      }
    }

    const pp = new PaisleyPark(ppConfig);
    await pp.init();

    try {
      // ─── Ingest ─────────────────────────────────────
      if (cacheHit) {
        const cachedFacts = await pp.search('', { minConfidence: 0 });
        const factCount = cachedFacts.length;
        totalFactsCreated += factCount;
        totalFactsAfterDedup += factCount;
        console.log(`  Cache hit: ${factCount} facts already ingested, skipping extraction`);
      } else {
        const { factsCreated, factsAfterDedup, extractionTokens } = await ingestConversation(
          config,
          pp,
          convo,
        );

        totalFactsCreated += factsCreated;
        totalFactsAfterDedup += factsAfterDedup;
        totalExtractionTokens += extractionTokens;

        console.log(`  Ingested: ${factsCreated} facts extracted, ${factsAfterDedup} after dedup`);
      }

      if (config.ingestOnly) {
        console.log('  [ingest-only] Skipping evaluation');
        continue;
      }

      // ─── Query & Evaluate ───────────────────────────
      for (let j = 0; j < convo.questions.length; j++) {
        const q = convo.questions[j];
        const qStart = Date.now();

        // Recall relevant facts
        const recallResult = await pp.recall(q.question, {
          limit: config.recallLimit,
          minConfidence: config.minConfidence,
        });

        // Generate answer from retrieved context
        const answerPrompt = `Context (retrieved from memory):\n${recallResult.formattedContext}\n\nQuestion: ${q.question}`;
        const answerResponse = await llmComplete(config, answerPrompt, {
          systemPrompt: ANSWER_SYSTEM_PROMPT,
        });
        totalAnswerTokens += answerResponse.tokensUsed;

        // Judge correctness
        const evalResult = await judgeAnswer(config, {
          question: q.question,
          expectedAnswer: q.answer,
          generatedAnswer: answerResponse.content,
        });
        totalEvalTokens += evalResult.tokensUsed;

        const latencyMs = Date.now() - qStart;

        allResults.push({
          questionId: q.question_id,
          question: q.question,
          expectedAnswer: q.answer,
          generatedAnswer: answerResponse.content,
          correct: evalResult.correct,
          category: q.category,
          latencyMs,
          factsRetrieved: recallResult.totalFound,
          tokensUsed: answerResponse.tokensUsed + evalResult.tokensUsed,
        });

        if ((j + 1) % 10 === 0) {
          console.log(`  Evaluated ${j + 1}/${convo.questions.length} questions`);
        }
      }
    } finally {
      await pp.destroy();
    }

    // Measure DB size
    try {
      const dbStat = await stat(dbPath);
      totalDbSize += dbStat.size;
    } catch {
      // ignore
    }
  }

  const durationSeconds = (Date.now() - startTime) / 1000;

  return {
    results: allResults,
    totalFactsCreated,
    totalFactsAfterDedup,
    totalExtractionTokens,
    totalAnswerTokens,
    totalEvalTokens,
    dbSizeBytes: totalDbSize,
    durationSeconds,
  };
}

async function ingestConversation(
  config: BenchmarkConfig,
  pp: PaisleyPark,
  convo: LocomoConversation,
): Promise<{ factsCreated: number; factsAfterDedup: number; extractionTokens: number }> {
  // Convert LOCOMO turns to chunker format
  const turns: ConversationTurn[] = convo.turns.map((t) => ({
    speaker: t.speaker,
    text: t.text,
    timestamp: convo.date,
  }));

  const chunks = chunkConversation(turns);
  const { facts, totalTokensUsed } = await extractFactsFromConversation(config, chunks, convo.date);

  let factsCreated = 0;

  for (const fact of facts) {
    try {
      // Handle supersedes: find and invalidate the old fact
      if (fact.supersedes) {
        const searchResult = await pp.search(fact.supersedes, {
          minConfidence: 0,
        });
        for (const existing of searchResult) {
          await pp.invalidate(existing.id, `Superseded: ${fact.supersedes}`);
        }
      }

      const addOptions: AddOptions = {
        type: fact.type,
        tags: fact.tags,
        confidence: fact.confidence,
        validFrom: fact.validFrom,
      };

      await pp.add(fact.content, addOptions);
      factsCreated++;
    } catch (e) {
      // Log but don't fail on individual fact errors
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('Fact rejected')) {
        console.warn(`  Warning: failed to add fact: ${msg}`);
      }
    }
  }

  // Count non-invalidated facts
  const allFacts = await pp.search('', { minConfidence: 0 });
  const factsAfterDedup = allFacts.length;

  return { factsCreated, factsAfterDedup, extractionTokens: totalTokensUsed };
}

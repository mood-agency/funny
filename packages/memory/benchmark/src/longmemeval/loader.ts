import { existsSync } from 'fs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import type {
  LongMemEvalDataset,
  LongMemSession,
  LongMemTurn,
  LongMemQuestion,
  ComplexityLevel,
} from './types.js';

/**
 * LongMemEval dataset: Multi-session conversations at different scales
 * with questions at 5 complexity levels.
 *
 * Source: https://huggingface.co/datasets/xiaowu0162/LongMemEval
 * Paper: https://arxiv.org/abs/2407.15045
 */
const LONGMEMEVAL_URLS: Record<string, string> = {
  S: 'https://huggingface.co/datasets/xiaowu0162/LongMemEval/resolve/main/data/longmemeval_s.json',
  M: 'https://huggingface.co/datasets/xiaowu0162/LongMemEval/resolve/main/data/longmemeval_m.json',
  L: 'https://huggingface.co/datasets/xiaowu0162/LongMemEval/resolve/main/data/longmemeval_l.json',
};

export async function loadLongMemEvalDataset(
  dataDir: string,
  size: 'S' | 'M' | 'L' = 'S',
): Promise<LongMemEvalDataset> {
  const cacheFile = `longmemeval_${size.toLowerCase()}.json`;
  const cachePath = join(dataDir, cacheFile);

  if (!existsSync(cachePath)) {
    console.log(`Downloading LongMemEval-${size} dataset...`);
    await mkdir(dataDir, { recursive: true });

    const url = LONGMEMEVAL_URLS[size];
    const res = await fetch(url);

    if (!res.ok) {
      // Try alternative URL patterns common for HuggingFace datasets
      console.log(`Primary URL failed (${res.status}), trying alternative...`);
      const altRes = await fetch(
        `https://huggingface.co/datasets/xiaowu0162/LongMemEval/resolve/main/longmemeval_${size.toLowerCase()}.json`,
      );
      if (!altRes.ok) {
        throw new Error(
          `Failed to download LongMemEval-${size}: ${res.status}. ` +
            `You can manually place the dataset file at ${cachePath}`,
        );
      }
      const text = await altRes.text();
      await writeFile(cachePath, text);
    } else {
      const text = await res.text();
      await writeFile(cachePath, text);
    }

    console.log(`Cached LongMemEval-${size} at ${cachePath}`);
  }

  const raw = await readFile(cachePath, 'utf-8');
  const data = JSON.parse(raw);

  return parseLongMemEvalData(data, size);
}

function parseLongMemEvalData(data: unknown, size: 'S' | 'M' | 'L'): LongMemEvalDataset {
  const root = data as Record<string, unknown>;

  // Parse sessions
  const rawSessions = (root.sessions ?? root.conversations ?? root.dialogs ?? []) as unknown[];
  const sessions: LongMemSession[] = rawSessions.map((s, i) => {
    const raw = s as Record<string, unknown>;
    const rawTurns = (raw.turns ?? raw.messages ?? raw.dialog ?? []) as unknown[];
    const turns: LongMemTurn[] = rawTurns.map((t) => {
      const turn = t as Record<string, unknown>;
      return {
        speaker: (turn.speaker ?? turn.role ?? 'user') as string,
        text: (turn.text ?? turn.content ?? '') as string,
      };
    });

    return {
      session_id: (raw.session_id ?? raw.id ?? `session-${i}`) as string,
      turns,
      timestamp: raw.timestamp as string | undefined,
    };
  });

  // Parse questions
  const rawQs = (root.questions ?? root.queries ?? root.qa_pairs ?? []) as unknown[];
  const questions: LongMemQuestion[] = rawQs.map((q, i) => {
    const raw = q as Record<string, unknown>;
    const level = (raw.level ?? raw.complexity ?? 1) as number;

    return {
      question_id: (raw.question_id ?? raw.id ?? `lme-q${i}`) as string,
      question: (raw.question ?? raw.query ?? '') as string,
      answer: (raw.answer ?? raw.ground_truth ?? '') as string,
      level: Math.max(1, Math.min(5, level)) as ComplexityLevel,
      requires_abstention: level === 5 || (raw.requires_abstention as boolean | undefined),
      relevant_sessions: raw.relevant_sessions as string[] | undefined,
    };
  });

  // Estimate total tokens (rough: 1 token ≈ 4 chars)
  const totalChars = sessions.reduce(
    (sum, s) => sum + s.turns.reduce((ts, t) => ts + t.text.length, 0),
    0,
  );

  return {
    size,
    sessions,
    questions,
    totalTokens: Math.ceil(totalChars / 4),
  };
}

import { existsSync } from 'fs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import type {
  LocomoConversation,
  LocomoDataset,
  LocomoQuestion,
  LocomoTurn,
  LocomoCategory,
} from './types.js';

/**
 * LOCOMO dataset: 10 long conversations (~300 turns each) with QA pairs
 * across 5 categories: single-hop, multi-hop, temporal, open-domain, adversarial.
 *
 * Source: https://github.com/snap-research/locomo
 * Paper: https://arxiv.org/abs/2312.07023
 */
const LOCOMO_URL = 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json';

export async function loadLocomoDataset(dataDir: string): Promise<LocomoDataset> {
  const cachePath = join(dataDir, 'locomo10.json');

  // Download if not cached
  if (!existsSync(cachePath)) {
    console.log('Downloading LOCOMO dataset...');
    await mkdir(dataDir, { recursive: true });

    const res = await fetch(LOCOMO_URL);
    if (!res.ok) {
      throw new Error(`Failed to download LOCOMO dataset: ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    await writeFile(cachePath, text);
    console.log(`Cached LOCOMO dataset at ${cachePath}`);
  }

  const raw = await readFile(cachePath, 'utf-8');
  const data = JSON.parse(raw);

  return parseLocomoData(data);
}

function parseLocomoData(data: unknown): LocomoDataset {
  // LOCOMO format: array of conversation objects or object with conversations key
  const conversations: LocomoConversation[] = [];
  let rawConvos: unknown[];

  if (Array.isArray(data)) {
    rawConvos = data;
  } else if (typeof data === 'object' && data !== null && 'conversations' in data) {
    rawConvos = (data as { conversations: unknown[] }).conversations;
  } else {
    throw new Error('Unexpected LOCOMO dataset format');
  }

  let totalTurns = 0;
  let totalQuestions = 0;

  for (let i = 0; i < rawConvos.length; i++) {
    const raw = rawConvos[i] as Record<string, unknown>;
    const convo = parseConversation(raw, i);
    conversations.push(convo);
    totalTurns += convo.turns.length;
    totalQuestions += convo.questions.length;
  }

  return { conversations, totalTurns, totalQuestions };
}

function parseConversation(raw: Record<string, unknown>, index: number): LocomoConversation {
  const id = (raw.conversation_id as string) ?? `locomo-${index}`;

  // Parse turns — may be under "conversation", "turns", or "dialog"
  const rawTurns = (raw.conversation ?? raw.turns ?? raw.dialog ?? []) as unknown[];
  const turns: LocomoTurn[] = rawTurns.map((t, j) => {
    const turn = t as Record<string, unknown>;
    return {
      speaker: (turn.speaker ?? turn.role ?? `Speaker${(j % 2) + 1}`) as string,
      text: (turn.text ?? turn.content ?? turn.utterance ?? '') as string,
      turn_number: (turn.turn_number ?? turn.turn_id ?? j) as number,
    };
  });

  // Parse questions — may be under "questions", "qa_pairs", or "qas"
  const rawQs = (raw.questions ?? raw.qa_pairs ?? raw.qas ?? []) as unknown[];
  const questions: LocomoQuestion[] = rawQs.map((q, j) => {
    const question = q as Record<string, unknown>;
    return {
      question_id: (question.question_id ?? question.id ?? `${id}-q${j}`) as string,
      question: (question.question ?? question.query ?? '') as string,
      answer: (question.answer ?? question.ground_truth ?? '') as string,
      category: normalizeCategory((question.category ?? question.type ?? 'single-hop') as string),
      evidence_turn_numbers: question.evidence_turn_numbers as number[] | undefined,
    };
  });

  return {
    conversation_id: id,
    turns,
    questions,
    date: raw.date as string | undefined,
  };
}

function normalizeCategory(raw: string): LocomoCategory {
  const lower = raw.toLowerCase().replace(/[\s_-]+/g, '-');
  const map: Record<string, LocomoCategory> = {
    'single-hop': 'single-hop',
    singlehop: 'single-hop',
    single: 'single-hop',
    'multi-hop': 'multi-hop',
    multihop: 'multi-hop',
    multi: 'multi-hop',
    temporal: 'temporal',
    time: 'temporal',
    'open-domain': 'open-domain',
    opendomain: 'open-domain',
    open: 'open-domain',
    adversarial: 'adversarial',
    adv: 'adversarial',
  };
  return map[lower] ?? 'single-hop';
}

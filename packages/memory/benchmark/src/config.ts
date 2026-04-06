import { homedir } from 'os';
import { join } from 'path';

import type { BenchmarkConfig, ChatMessage, LLMResponse } from './types.js';

const DEFAULT_DB_DIR = join(homedir(), '.funny', 'benchmark', 'db');
const DEFAULT_DATA_DIR = join(homedir(), '.funny', 'benchmark', 'data');

export function createConfig(overrides: Partial<BenchmarkConfig> = {}): BenchmarkConfig {
  return {
    model: overrides.model ?? process.env.BENCH_MODEL ?? 'claude-haiku',
    judgeModel: overrides.judgeModel ?? process.env.BENCH_JUDGE_MODEL ?? 'claude-sonnet',
    apiBaseUrl:
      overrides.apiBaseUrl ?? process.env.OPENAI_API_BASE_URL ?? 'http://localhost:4010/v1',
    apiKey: overrides.apiKey ?? process.env.OPENAI_API_KEY ?? 'no-key-needed',
    recallLimit: overrides.recallLimit ?? 15,
    minConfidence: overrides.minConfidence ?? 0.3,
    dbDir: overrides.dbDir ?? DEFAULT_DB_DIR,
    dataDir: overrides.dataDir ?? DEFAULT_DATA_DIR,
    ingestOnly: overrides.ingestOnly ?? false,
    reuseCache: overrides.reuseCache ?? false,
  };
}

// ─── LLM Client (supports both /v1/runs and OpenAI-compatible /v1/chat/completions) ──────────────────────────

export async function llmChat(
  config: BenchmarkConfig,
  messages: ChatMessage[],
  options?: { model?: string; temperature?: number; maxTokens?: number },
): Promise<LLMResponse> {
  const model = options?.model ?? config.model;

  // Try /v1/runs first (funny-api-acp), fall back to /v1/chat/completions (OpenAI-compatible)
  if (config.apiBaseUrl.includes('localhost') || config.apiBaseUrl.includes('127.0.0.1')) {
    return llmChatViaRuns(config, messages, { ...options, model });
  }

  return llmChatViaOpenAI(config, messages, { ...options, model });
}

async function llmChatViaRuns(
  config: BenchmarkConfig,
  messages: ChatMessage[],
  options: { model?: string; temperature?: number; maxTokens?: number },
): Promise<LLMResponse> {
  const model = options.model ?? config.model;
  const url = `${config.apiBaseUrl}/runs`;

  // Convert messages array to prompt + system_prompt for the runs API
  const systemMsg = messages.find((m) => m.role === 'system');
  const userMsgs = messages.filter((m) => m.role !== 'system');
  const prompt = userMsgs.map((m) => m.content).join('\n\n');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      system_prompt: systemMsg?.content,
      stream: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM API error (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    result?: { text?: string };
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const inputTokens = data.usage?.input_tokens ?? 0;
  const outputTokens = data.usage?.output_tokens ?? 0;

  return {
    content: data.result?.text ?? '',
    tokensUsed: inputTokens + outputTokens,
  };
}

async function llmChatViaOpenAI(
  config: BenchmarkConfig,
  messages: ChatMessage[],
  options: { model?: string; temperature?: number; maxTokens?: number },
): Promise<LLMResponse> {
  const model = options.model ?? config.model;
  const url = `${config.apiBaseUrl}/chat/completions`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: options.temperature ?? 0,
      max_tokens: options.maxTokens ?? 2048,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM API error (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { total_tokens?: number };
  };

  return {
    content: data.choices[0]?.message?.content ?? '',
    tokensUsed: data.usage?.total_tokens ?? 0,
  };
}

/** Simple single-prompt completion helper */
export async function llmComplete(
  config: BenchmarkConfig,
  prompt: string,
  options?: { model?: string; systemPrompt?: string; temperature?: number },
): Promise<LLMResponse> {
  const messages: ChatMessage[] = [];
  if (options?.systemPrompt) {
    messages.push({ role: 'system', content: options.systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });
  return llmChat(config, messages, { model: options?.model, temperature: options?.temperature });
}

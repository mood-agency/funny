import { llmComplete } from '../config.js';
import type { BenchmarkConfig } from '../types.js';

const JUDGE_SYSTEM_PROMPT = `You are an evaluation judge. Given a question, the expected answer, and a generated answer, determine if the generated answer is CORRECT or WRONG.

Rules:
1. The generated answer is CORRECT if it conveys the same essential information as the expected answer, even if phrased differently
2. Partial answers that include the key information are CORRECT
3. Answers with minor additional details beyond the expected answer are still CORRECT
4. Factually incorrect or contradictory answers are WRONG
5. "I don't know" or refusal to answer is WRONG (unless the expected answer is also "I don't know")
6. Empty or irrelevant answers are WRONG

Respond with exactly one word: CORRECT or WRONG`;

export interface JudgeInput {
  question: string;
  expectedAnswer: string;
  generatedAnswer: string;
}

export interface JudgeResult {
  correct: boolean;
  tokensUsed: number;
}

/**
 * LLM-as-Judge: evaluates if a generated answer matches the expected answer.
 * Uses the judge model (typically GPT-4o) for highest quality evaluation.
 */
export async function judgeAnswer(
  config: BenchmarkConfig,
  input: JudgeInput,
): Promise<JudgeResult> {
  const prompt = `Question: ${input.question}

Expected Answer: ${input.expectedAnswer}

Generated Answer: ${input.generatedAnswer}

Is the generated answer CORRECT or WRONG?`;

  const response = await llmComplete(config, prompt, {
    model: config.judgeModel,
    systemPrompt: JUDGE_SYSTEM_PROMPT,
    temperature: 0,
  });

  const verdict = response.content.trim().toUpperCase();
  const correct = verdict.includes('CORRECT');

  return { correct, tokensUsed: response.tokensUsed };
}

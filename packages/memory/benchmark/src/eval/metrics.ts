import type {
  QuestionResult,
  BenchmarkMetrics,
  CategoryMetrics,
  LatencyMetrics,
} from '../types.js';

/**
 * Compute aggregate metrics from individual question results.
 */
export function computeMetrics(
  benchmarkName: string,
  results: QuestionResult[],
  extra: {
    model: string;
    recallLimit: number;
    totalFactsCreated: number;
    totalFactsAfterDedup: number;
    dbSizeBytes: number;
    durationSeconds: number;
  },
): BenchmarkMetrics {
  const totalQuestions = results.length;
  const totalCorrect = results.filter((r) => r.correct).length;
  const overallAccuracy = totalQuestions > 0 ? totalCorrect / totalQuestions : 0;

  // Category breakdown
  const categories = new Map<string, { total: number; correct: number }>();
  for (const r of results) {
    const cat = categories.get(r.category) ?? { total: 0, correct: 0 };
    cat.total++;
    if (r.correct) cat.correct++;
    categories.set(r.category, cat);
  }

  const categoryBreakdown: CategoryMetrics[] = [...categories.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([category, { total, correct }]) => ({
      category,
      total,
      correct,
      accuracy: total > 0 ? correct / total : 0,
    }));

  // Latency metrics
  const latency = computeLatencyMetrics(results.map((r) => r.latencyMs));

  // Total tokens
  const totalTokensUsed = results.reduce((sum, r) => sum + r.tokensUsed, 0);

  return {
    benchmark: benchmarkName,
    model: extra.model,
    recallLimit: extra.recallLimit,
    overallAccuracy,
    categoryBreakdown,
    latency,
    totalQuestions,
    totalCorrect,
    totalFactsCreated: extra.totalFactsCreated,
    totalFactsAfterDedup: extra.totalFactsAfterDedup,
    totalTokensUsed,
    dbSizeBytes: extra.dbSizeBytes,
    durationSeconds: extra.durationSeconds,
  };
}

function computeLatencyMetrics(values: number[]): LatencyMetrics {
  if (values.length === 0) {
    return { p50: 0, p95: 0, p99: 0, mean: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;

  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    mean: Math.round(mean),
  };
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

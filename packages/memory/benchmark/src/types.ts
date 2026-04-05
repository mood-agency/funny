// ─── Benchmark Configuration ────────────────────────────────

export interface BenchmarkConfig {
  /** Model for extraction + answer generation (e.g. gpt-4o-mini, gpt-4o) */
  model: string;
  /** Model for LLM-as-Judge evaluation (e.g. gpt-4o) */
  judgeModel: string;
  /** OpenAI-compatible API base URL */
  apiBaseUrl: string;
  /** API key */
  apiKey: string;
  /** Number of facts to retrieve per query */
  recallLimit: number;
  /** Minimum confidence threshold for recall */
  minConfidence: number;
  /** Directory for benchmark databases */
  dbDir: string;
  /** Directory for cached datasets */
  dataDir: string;
  /** Dry run — ingest only, no evaluation */
  dryRun: boolean;
}

// ─── Extracted Fact ─────────────────────────────────────────

export interface ExtractedFact {
  content: string;
  type: 'decision' | 'bug' | 'pattern' | 'convention' | 'insight' | 'context';
  tags: string[];
  confidence: number;
  validFrom?: string;
  supersedes?: string;
}

// ─── Question Result ────────────────────────────────────────

export interface QuestionResult {
  questionId: string;
  question: string;
  expectedAnswer: string;
  generatedAnswer: string;
  correct: boolean;
  category: string;
  latencyMs: number;
  factsRetrieved: number;
  tokensUsed: number;
}

// ─── Metrics ────────────────────────────────────────────────

export interface CategoryMetrics {
  category: string;
  total: number;
  correct: number;
  accuracy: number;
}

export interface LatencyMetrics {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
}

export interface BenchmarkMetrics {
  benchmark: string;
  model: string;
  recallLimit: number;
  overallAccuracy: number;
  categoryBreakdown: CategoryMetrics[];
  latency: LatencyMetrics;
  totalQuestions: number;
  totalCorrect: number;
  totalFactsCreated: number;
  totalFactsAfterDedup: number;
  totalTokensUsed: number;
  dbSizeBytes: number;
  durationSeconds: number;
}

// ─── LLM Client ─────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  tokensUsed: number;
}

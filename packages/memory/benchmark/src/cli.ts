#!/usr/bin/env bun

import { createConfig } from './config.js';
import { computeMetrics } from './eval/metrics.js';
import { runLocomoBenchmark } from './locomo/runner.js';
import { runLongMemEvalBenchmark } from './longmemeval/runner.js';
import { printReport } from './report/console.js';
import { writeJsonReport } from './report/json.js';
import type { BenchmarkConfig } from './types.js';

function printUsage(): void {
  console.log(`
Usage: bun run bench <benchmark> [options]

Benchmarks:
  locomo          Run LOCOMO benchmark (10 conversations, ~300 questions)
  longmemeval     Run LongMemEval benchmark (multi-session, 5 complexity levels)

Options:
  --model <name>         Extraction/answer model (default: gpt-4o-mini)
  --judge-model <name>   Evaluation judge model (default: gpt-4o)
  --recall-limit <n>     Facts to retrieve per query (default: 15)
  --min-confidence <n>   Minimum confidence threshold (default: 0.3)
  --size <S|M|L>         LongMemEval dataset size (default: S)
  --dry-run              Ingest only, skip evaluation
  --help                 Show this help

Environment variables:
  OPENAI_API_KEY         Required: OpenAI API key
  OPENAI_API_BASE_URL    API base URL (default: https://api.openai.com/v1)
  BENCH_MODEL            Default extraction model
  BENCH_JUDGE_MODEL      Default judge model

Examples:
  bun run bench locomo
  bun run bench locomo --model gpt-4o-mini --recall-limit 20
  bun run bench longmemeval --size S
  bun run bench longmemeval --size M --model gpt-4o
  bun run bench locomo --dry-run
`);
}

function parseArgs(args: string[]): {
  benchmark: string | null;
  options: Partial<BenchmarkConfig>;
  size: 'S' | 'M' | 'L';
} {
  const options: Partial<BenchmarkConfig> = {};
  let benchmark: string | null = null;
  let size: 'S' | 'M' | 'L' = 'S';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--model' && args[i + 1]) {
      options.model = args[++i];
      continue;
    }

    if (arg === '--judge-model' && args[i + 1]) {
      options.judgeModel = args[++i];
      continue;
    }

    if (arg === '--recall-limit' && args[i + 1]) {
      options.recallLimit = parseInt(args[++i], 10);
      continue;
    }

    if (arg === '--min-confidence' && args[i + 1]) {
      options.minConfidence = parseFloat(args[++i]);
      continue;
    }

    if (arg === '--size' && args[i + 1]) {
      const s = args[++i].toUpperCase();
      if (s === 'S' || s === 'M' || s === 'L') {
        size = s;
      } else {
        console.error(`Invalid size: ${s}. Must be S, M, or L.`);
        process.exit(1);
      }
      continue;
    }

    if (!arg.startsWith('-') && !benchmark) {
      benchmark = arg.toLowerCase();
      continue;
    }
  }

  return { benchmark, options, size };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { benchmark, options, size } = parseArgs(args);

  if (!benchmark) {
    printUsage();
    process.exit(1);
  }

  const config = createConfig(options);

  // Validate API key
  if (!config.apiKey) {
    console.error('Error: OPENAI_API_KEY environment variable is required');
    process.exit(1);
  }

  console.log(`Paisley Park Benchmark Suite`);
  console.log(
    `Model: ${config.model} | Judge: ${config.judgeModel} | Recall limit: ${config.recallLimit}`,
  );
  if (config.dryRun) console.log(`Mode: DRY RUN (ingest only)`);
  console.log('');

  switch (benchmark) {
    case 'locomo': {
      const result = await runLocomoBenchmark(config);

      if (!config.dryRun && result.results.length > 0) {
        const metrics = computeMetrics('LOCOMO', result.results, {
          model: config.model,
          recallLimit: config.recallLimit,
          totalFactsCreated: result.totalFactsCreated,
          totalFactsAfterDedup: result.totalFactsAfterDedup,
          dbSizeBytes: result.dbSizeBytes,
          durationSeconds: result.durationSeconds,
        });

        printReport(metrics);
        await writeJsonReport(config.dataDir, metrics, result.results);
      } else {
        console.log(`\nDry run complete.`);
        console.log(`  Facts created: ${result.totalFactsCreated}`);
        console.log(`  Facts after dedup: ${result.totalFactsAfterDedup}`);
        console.log(`  Extraction tokens: ${result.totalExtractionTokens}`);
        console.log(`  Duration: ${result.durationSeconds.toFixed(1)}s`);
      }
      break;
    }

    case 'longmemeval': {
      const result = await runLongMemEvalBenchmark(config, size);

      if (!config.dryRun && result.results.length > 0) {
        const metrics = computeMetrics(`LongMemEval-${size}`, result.results, {
          model: config.model,
          recallLimit: config.recallLimit,
          totalFactsCreated: result.totalFactsCreated,
          totalFactsAfterDedup: result.totalFactsAfterDedup,
          dbSizeBytes: result.dbSizeBytes,
          durationSeconds: result.durationSeconds,
        });

        printReport(metrics);
        await writeJsonReport(config.dataDir, metrics, result.results);
      } else {
        console.log(`\nDry run complete.`);
        console.log(`  Facts created: ${result.totalFactsCreated}`);
        console.log(`  Facts after dedup: ${result.totalFactsAfterDedup}`);
        console.log(`  Extraction tokens: ${result.totalExtractionTokens}`);
        console.log(`  Duration: ${result.durationSeconds.toFixed(1)}s`);
      }
      break;
    }

    default:
      console.error(`Unknown benchmark: ${benchmark}`);
      console.error('Available: locomo, longmemeval');
      process.exit(1);
  }
}

main().catch((e) => {
  console.error('Benchmark failed:', e);
  process.exit(1);
});

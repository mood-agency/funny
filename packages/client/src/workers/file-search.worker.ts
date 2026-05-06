/// <reference lib="webworker" />

/**
 * File-search Web Worker.
 *
 * Receives a `setIndex` message with the full file list, then scores against
 * any number of `search` queries. Scoring runs on the worker thread so the
 * main thread stays at 60fps even when the index has 100k+ files.
 *
 * Cancellation: every `search` carries a `requestId`. The worker bails out
 * early if a newer request arrives while it is still scoring (cooperative
 * cancellation via a yield every N items).
 */

interface SetIndexMessage {
  type: 'setIndex';
  files: string[];
  /** MRU paths (e.g. recently opened files) — boosted in scoring. */
  recents?: string[];
}

interface SearchMessage {
  type: 'search';
  requestId: number;
  query: string;
  limit: number;
}

type InboundMessage = SetIndexMessage | SearchMessage;

interface Match {
  path: string;
  score: number;
  /** Indices into `path` that matched the query, used for highlight. */
  indices: number[];
}

interface SearchResultMessage {
  type: 'searchResult';
  requestId: number;
  matches: Match[];
  truncated: boolean;
  total: number;
}

let files: string[] = [];
let lowerFiles: string[] = [];
let recentSet = new Set<string>();
let latestRequestId = 0;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (e: MessageEvent<InboundMessage>) => {
  const msg = e.data;
  if (msg.type === 'setIndex') {
    files = msg.files;
    lowerFiles = msg.files.map((f) => f.toLowerCase());
    recentSet = new Set(msg.recents ?? []);
    return;
  }
  if (msg.type === 'search') {
    latestRequestId = msg.requestId;
    runSearch(msg.requestId, msg.query, msg.limit);
  }
});

/** Single-char queries that match almost every file — skip the heavy scoring. */
function isPermissiveSingleChar(q: string): boolean {
  if (q.length !== 1) return false;
  const c = q.charCodeAt(0);
  // Not a letter or digit → effectively matches every path
  return !((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122));
}

function runSearch(requestId: number, query: string, limit: number): void {
  const trimmed = query.trim();
  if (trimmed.length === 0 || isPermissiveSingleChar(trimmed)) {
    // Empty query — just return MRU first, then alphabetic
    const matches: Match[] = [];
    const seen = new Set<string>();
    for (const r of recentSet) {
      if (seen.has(r)) continue;
      seen.add(r);
      matches.push({ path: r, score: 0, indices: [] });
      if (matches.length >= limit) break;
    }
    if (matches.length < limit) {
      for (const f of files) {
        if (seen.has(f)) continue;
        matches.push({ path: f, score: 1, indices: [] });
        if (matches.length >= limit) break;
      }
    }
    postResult(requestId, matches, files.length > limit, files.length);
    return;
  }

  const lowerQuery = trimmed.toLowerCase();
  const isCaseSensitive = trimmed !== lowerQuery; // mixed-case → case-sensitive
  const scored: Match[] = [];

  // Yield to the event loop every CHUNK iterations so cancellation can take
  // effect when the user types another character. Bigger chunks reduce the
  // 4ms-per-setTimeout overhead — for 100k files, 5000-chunks added 80ms,
  // 25000-chunks adds 16ms.
  const CHUNK = 25000;
  let i = 0;

  const score = isCaseSensitive
    ? (haystack: string) => fzfScore(haystack, trimmed, true)
    : (haystack: string) => fzfScore(haystack, lowerQuery, false);

  const iterate = (): void => {
    if (requestId !== latestRequestId) return; // cancelled

    const end = Math.min(i + CHUNK, files.length);
    for (; i < end; i++) {
      const haystack = isCaseSensitive ? files[i] : lowerFiles[i];
      const result = score(haystack);
      if (result) {
        const path = files[i];
        let s = result.score;
        if (recentSet.has(path)) s += 200; // MRU bonus
        scored.push({ path, score: s, indices: result.indices });
      }
    }

    if (i < files.length) {
      // Yield then continue
      setTimeout(iterate, 0);
      return;
    }

    // Sort: descending score, ties by path length asc, then lexical
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.path.length !== b.path.length) return a.path.length - b.path.length;
      return a.path < b.path ? -1 : 1;
    });

    const total = scored.length;
    const matches = scored.slice(0, limit);
    postResult(requestId, matches, total > limit, total);
  };

  iterate();
}

function postResult(requestId: number, matches: Match[], truncated: boolean, total: number): void {
  const out: SearchResultMessage = {
    type: 'searchResult',
    requestId,
    matches,
    truncated,
    total,
  };
  ctx.postMessage(out);
}

// ── Scoring ──────────────────────────────────────────────────
//
// VSCode-style fuzzy scoring. The query characters must appear in `haystack`
// in order, but not necessarily consecutively. Bonuses for:
//   - matches at word boundaries (e.g. after `/`, `_`, `-`, camelCase)
//   - matches in the file *name* (last path segment) over directory matches
//   - consecutive matches
//   - prefix matches
// Penalties for non-matched characters between matches.
//
// Returns `null` when the query doesn't fuzzy-match. Otherwise `{ score,
// indices }` where `indices` are positions in `haystack` for highlighting.

interface FzfResult {
  score: number;
  indices: number[];
}

function fzfScore(haystack: string, needle: string, caseSensitive: boolean): FzfResult | null {
  if (needle.length === 0) return { score: 0, indices: [] };

  const filenameStart = haystack.lastIndexOf('/') + 1;

  // Quick reject: each char of needle must appear in haystack in order
  let h = 0;
  for (let n = 0; n < needle.length; n++) {
    const nc = needle[n];
    while (h < haystack.length && haystack[h] !== nc) h++;
    if (h === haystack.length) return null;
    h++;
  }

  // Greedy left-to-right with backtracking for "best next match" using the
  // forward pass — then a recompute that rewards consecutive runs.
  const indices: number[] = [];
  let pos = 0;
  for (let n = 0; n < needle.length; n++) {
    const nc = needle[n];
    let found = -1;
    // Prefer word-start matches in this lookahead
    let wordStart = -1;
    for (let h = pos; h < haystack.length; h++) {
      if (haystack[h] !== nc) continue;
      if (found === -1) found = h;
      if (isWordStart(haystack, h, filenameStart)) {
        wordStart = h;
        break;
      }
      // If the very next char matches and we already had a hit, prefer the
      // first hit to maintain consecutive runs.
      if (n > 0 && indices[n - 1] === h - 1) {
        found = h;
        break;
      }
    }
    const pick = wordStart !== -1 ? wordStart : found;
    if (pick === -1) return null;
    indices.push(pick);
    pos = pick + 1;
  }

  // Score from indices
  let score = 0;
  for (let i = 0; i < indices.length; i++) {
    const h = indices[i];
    const ch = haystack[h];

    // Base hit
    score += 16;

    // Filename match is much stronger than path match
    if (h >= filenameStart) score += 8;

    // Word-start bonus
    if (isWordStart(haystack, h, filenameStart)) score += 24;

    // Consecutive bonus
    if (i > 0 && indices[i - 1] === h - 1) score += 16;

    // Case-sensitive match bonus (rewards exact-case typing)
    if (caseSensitive && ch === needle[i]) score += 4;
  }

  // Penalty for characters between matches that weren't matched
  if (indices.length > 0) {
    const span = indices[indices.length - 1] - indices[0] + 1;
    const gap = span - indices.length;
    score -= gap * 2;
  }

  // First-character-of-filename bonus: typing "rou" should rank
  // routes/something high
  if (indices[0] === filenameStart) score += 32;

  // Whole-needle prefix-of-filename bonus (e.g. "use" → useThing.ts)
  if (indices[0] === filenameStart && indices.every((h, i) => h === filenameStart + i)) {
    score += 64;
  }

  // Penalize long paths slightly so shorter paths win on ties
  score -= Math.floor(haystack.length / 32);

  return { score, indices };
}

function isWordStart(s: string, i: number, filenameStart: number): boolean {
  if (i === 0 || i === filenameStart) return true;
  const prev = s.charCodeAt(i - 1);
  const cur = s.charCodeAt(i);

  // Boundary chars: '/', '\\', '_', '-', '.', ' '
  if (
    prev === 47 /* / */ ||
    prev === 92 /* \\ */ ||
    prev === 95 /* _ */ ||
    prev === 45 /* - */ ||
    prev === 46 /* . */ ||
    prev === 32 /*   */
  ) {
    return true;
  }
  // camelCase: prev is lowercase, cur is uppercase
  if (prev >= 97 && prev <= 122 && cur >= 65 && cur <= 90) return true;
  return false;
}

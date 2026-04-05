export interface ConversationTurn {
  speaker: string;
  text: string;
  timestamp?: string;
}

export interface ConversationChunk {
  turns: ConversationTurn[];
  startIndex: number;
  endIndex: number;
}

/**
 * Sliding window chunker for conversation turns.
 * Splits a conversation into overlapping windows for LLM extraction.
 *
 * @param turns - Full conversation turns
 * @param windowSize - Number of turns per chunk (default: 20)
 * @param overlap - Number of overlapping turns between chunks (default: 5)
 */
export function chunkConversation(
  turns: ConversationTurn[],
  windowSize: number = 20,
  overlap: number = 5,
): ConversationChunk[] {
  if (turns.length === 0) return [];
  if (turns.length <= windowSize) {
    return [{ turns, startIndex: 0, endIndex: turns.length - 1 }];
  }

  const chunks: ConversationChunk[] = [];
  const step = windowSize - overlap;

  for (let i = 0; i < turns.length; i += step) {
    const end = Math.min(i + windowSize, turns.length);
    chunks.push({
      turns: turns.slice(i, end),
      startIndex: i,
      endIndex: end - 1,
    });
    if (end === turns.length) break;
  }

  return chunks;
}

/** Format turns into a readable conversation string for LLM consumption */
export function formatChunkForLLM(chunk: ConversationChunk): string {
  return chunk.turns
    .map((t) => {
      const ts = t.timestamp ? ` [${t.timestamp}]` : '';
      return `${t.speaker}${ts}: ${t.text}`;
    })
    .join('\n');
}

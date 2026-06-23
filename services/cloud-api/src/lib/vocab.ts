export type SeenVocab = Record<string, number>;

export const MAX_VOCAB_PAYLOAD_BYTES = 500 * 1024;

export function mergeSeenVocab(
  existing: SeenVocab,
  incoming: SeenVocab
): SeenVocab {
  const merged: SeenVocab = { ...existing };

  for (const [word, count] of Object.entries(incoming)) {
    const existingCount = merged[word] ?? 0;
    const incomingCount = typeof count === "number" ? count : 0;
    merged[word] = Math.max(existingCount, incomingCount);
  }

  return merged;
}

export function parseSeenVocabJson(value: unknown): SeenVocab | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const result: SeenVocab = {};
  for (const [word, count] of Object.entries(value as Record<string, unknown>)) {
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
      return null;
    }
    result[word] = count;
  }

  return result;
}

export function vocabPayloadTooLarge(seenVocab: SeenVocab): boolean {
  return Buffer.byteLength(JSON.stringify(seenVocab), "utf8") > MAX_VOCAB_PAYLOAD_BYTES;
}

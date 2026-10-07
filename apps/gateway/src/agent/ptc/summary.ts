/** First sentence of a description, bounded (capability summaries in the prompt and ptc_docs). */
export function summaryOf(description: string, max = 160): string {
  // A sentence ends at . ! ? before a capital letter ("e.g. `**/*.ts`" does not end one).
  const first = description.trim().split(/(?<=[.!?])\s+(?=[A-Z])|\n/)[0] ?? '';
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

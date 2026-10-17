/** Read real source labels from the observer's user prompt, excluding examples. */
export function fixtureMemorySources(prompt) {
  const marker = '\nNEW CONVERSATION CHUNK:\n';
  const offset = prompt.indexOf(marker);
  if (offset < 0) return [];
  const chunk = prompt.slice(offset + marker.length);
  return [...new Set([...chunk.matchAll(/^\[Source entry id:\s*([A-Za-z0-9_-]+)\]$/gm)].map(match => match[1]))];
}

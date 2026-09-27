/** Time formatting shared by the sidebar, panels and jobs menu. */

type Instant = string | number | Date;

const ms = (value: Instant) => new Date(value).getTime();

/** "just now", "5m ago", "3h ago", "2d ago", then the date (Git history). */
export function ago(time: Instant, now = Date.now()): string {
  const seconds = Math.max(0, (now - ms(time)) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 30 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(time).toLocaleDateString();
}

/** Compact age for dense lists: "now", "5m", "3h", "2d". */
export function shortAgo(time: Instant, now = Date.now()): string {
  const delta = now - ms(time);
  if (delta < 60_000) return 'now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}

/** Wall-clock run time, "12s", "3m 4s", "1h 2m"; open-ended runs count up to `now`. */
export function duration(start?: Instant, end?: Instant, now = Date.now()): string {
  if (!start) return '';
  const to = end ? ms(end) : now;
  const seconds = Math.max(0, Math.round((to - ms(start)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** Precise elapsed time between two instants, "420 ms", "1.2 s", "14 s" (tool calls). */
export function elapsed(start?: Instant, end?: Instant): string {
  if (!start || !end) return '';
  const delta = ms(end) - ms(start);
  if (!(delta >= 0)) return '';
  return delta < 1000 ? `${delta} ms` : `${(delta / 1000).toFixed(delta < 10_000 ? 1 : 0)} s`;
}

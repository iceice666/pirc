/**
 * One theme ships: the design's dark palette (app.css). The light tokens stay
 * under `:root[data-theme='light']` for later, but nothing sets the attribute,
 * so anything that needs to know (the terminal, Mermaid diagrams) asks here
 * rather than the operating system's preference.
 */
export function isDarkTheme(): boolean {
  return typeof document === 'undefined' || document.documentElement.dataset.theme !== 'light';
}

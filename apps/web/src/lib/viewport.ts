/**
 * Keep the app as tall as the part of the screen the user can see.
 *
 * Android Chrome shrinks the layout viewport for the soft keyboard once the
 * viewport meta asks for `interactive-widget=resizes-content`, so `100%` is
 * enough there. iOS Safari never resizes the layout viewport: it scrolls the
 * page under the keyboard instead, pushing the top bar off screen. There
 * `visualViewport` reports the visible height, which becomes `--app-height`.
 *
 * Pinch zoom also shrinks the visual viewport; multiplying by `scale` keeps
 * the app from collapsing while zoomed. Returns the cleanup function.
 */
export function trackViewportHeight(root: HTMLElement = document.documentElement): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => undefined;
  let frame = 0;
  const update = () => {
    frame = 0;
    const height = Math.round(viewport.height * viewport.scale);
    root.style.setProperty('--app-height', `${height}px`);
    // iOS scrolled the (fixed-size) page to reveal the focused field; the app
    // now fits above the keyboard, so undo that scroll.
    if (viewport.scale === 1 && (window.scrollY || document.documentElement.scrollTop))
      window.scrollTo(0, 0);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  update();
  viewport.addEventListener('resize', schedule);
  viewport.addEventListener('scroll', schedule);
  return () => {
    cancelAnimationFrame(frame);
    viewport.removeEventListener('resize', schedule);
    viewport.removeEventListener('scroll', schedule);
    root.style.removeProperty('--app-height');
  };
}

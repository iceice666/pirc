<script lang="ts" module>
  /**
   * The one status vocabulary (design change #16): a green dot is working, a
   * hollow ring is idle (or done), a yellow square waits for you, and a red
   * tint is a failure. Every surface uses these four shapes, so the same
   * state reads the same in the rooms, a thread, the engine and the jobs menu.
   */
  export type GlyphState = 'working' | 'idle' | 'waiting' | 'error';

  /** The glyph for a state name from any of the app's vocabularies. */
  export function glyphOf(state: string): GlyphState {
    switch (state) {
      case 'working':
      case 'thinking':
      case 'ongoing':
      case 'running':
      case 'live':
      case 'busy':
        return 'working';
      case 'waiting':
      case 'waiting_input':
      case 'queued':
      case 'asking':
        return 'waiting';
      case 'error':
      case 'failed':
      case 'failing':
      case 'offline':
        return 'error';
      default:
        // idle, done, completed, paused
        return 'idle';
    }
  }
</script>

<script lang="ts">
  interface Props {
    state: GlyphState;
    /** Pixels; the comps use 8, 12 and 16. */
    size?: number;
    /** A working glyph breathes so a long job is visible at a glance. */
    pulse?: boolean;
    /** Spoken instead of decorative when the owner has no text beside it. */
    label?: string;
  }

  let { state, size = 8, pulse = false, label }: Props = $props();
</script>

<span
  class="glyph {state}"
  class:pulse
  style:--size="{size}px"
  role={label ? 'img' : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : 'true'}
></span>

<style>
  .glyph {
    flex: none;
    display: inline-block;
    width: var(--size);
    height: var(--size);
    border-radius: 50%;
    background: var(--faint);
  }
  .glyph.working {
    background: var(--success);
  }
  .glyph.pulse {
    animation: glyph-pulse 1.6s var(--ease) infinite;
  }
  .glyph.idle {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px var(--faint);
  }
  .glyph.waiting {
    border-radius: 2px;
    background: var(--warning);
  }
  .glyph.error {
    background: var(--danger);
  }
  @keyframes glyph-pulse {
    0% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--success) 45%, transparent);
    }
    70%,
    100% {
      box-shadow: 0 0 0 4px transparent;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .glyph.pulse {
      animation: none;
    }
  }
</style>

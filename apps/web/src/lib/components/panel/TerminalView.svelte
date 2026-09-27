<script lang="ts">
  /**
   * One live terminal. xterm.js is loaded on first use (it is large); the
   * socket reconnects with backoff and the gateway replays scrollback, so the
   * view is rebuilt from scratch on every (re)connect.
   */
  import { onDestroy, onMount, untrack } from 'svelte';
  import { panelApi, type TerminalInfo } from '../../panel-api';
  import { getClientId } from '../../storage';
  import { watch } from '../../watch.svelte';

  interface Props {
    sessionId: string;
    terminal: TerminalInfo;
    generation: number | undefined;
    hasControl: boolean;
    visible?: boolean;
    onexit?: (exitCode: number | null) => void;
  }

  let {
    sessionId,
    terminal,
    generation,
    hasControl,
    visible = true,
    onexit = () => {},
  }: Props = $props();

  let host: HTMLDivElement;
  let notice = $state('');
  let destroyed = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let exited = untrack(() => terminal.exited);
  let xterm: import('@xterm/xterm').Terminal | undefined = $state();
  let fit: import('@xterm/addon-fit').FitAddon | undefined;
  let observer: ResizeObserver | undefined;

  function theme() {
    const style = getComputedStyle(document.documentElement);
    const color = (name: string, fallback: string) =>
      style.getPropertyValue(name).trim() || fallback;
    return {
      background: color('--code-bg', '#f6f7f9'),
      foreground: color('--code-ink', '#24292f'),
      cursor: color('--accent', '#4176e6'),
      selectionBackground: color('--accent-soft', '#edf3fe'),
    };
  }

  function send(message: Record<string, unknown>) {
    if (socket?.readyState !== WebSocket.OPEN || generation === undefined) return;
    socket.send(JSON.stringify({ ...message, clientId: getClientId(), generation }));
  }

  /** Size last sent to the pty; a resize the pty already has is not sent again. */
  let sentSize = '';
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;

  /** Fit the view to its box and tell the pty (each change sends it a SIGWINCH). */
  function resize() {
    if (!fit || !xterm || !visible || !host?.offsetWidth) return;
    fit.fit();
    const size = `${xterm.cols}x${xterm.rows}`;
    if (!hasControl || socket?.readyState !== WebSocket.OPEN || size === sentSize) return;
    sentSize = size;
    send({ type: 'resize', cols: xterm.cols, rows: xterm.rows });
  }
  /** Dragging the panel edge fires a resize per pointer move; settle first. */
  function scheduleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 50);
  }

  function connect() {
    if (destroyed || exited) return;
    socket = new WebSocket(panelApi.terminalUrl(sessionId, terminal.id));
    socket.addEventListener('message', (event) => {
      let message: any;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === 'ready') {
        attempts = 0;
        notice = '';
        xterm?.reset();
        xterm?.write(message.replay ?? '');
        // A new connection may start at another size.
        sentSize = '';
        resize();
      } else if (message.type === 'output') xterm?.write(message.data);
      else if (message.type === 'exit') {
        exited = true;
        xterm?.write(
          `\r\n\x1b[2m[process exited${message.exitCode === null ? '' : ` with code ${message.exitCode}`}]\x1b[0m\r\n`,
        );
        onexit(message.exitCode ?? null);
      } else if (message.type === 'error' && message.code === 'lost_control')
        notice = 'Take control of the session to type here.';
    });
    socket.addEventListener('close', (event) => {
      if (destroyed || exited) return;
      if (event.code === 4404) {
        exited = true;
        notice = 'This terminal no longer exists.';
        onexit(null);
        return;
      }
      notice = 'Reconnecting…';
      retry = setTimeout(connect, Math.min(10_000, 500 * 2 ** attempts++));
    });
  }

  onMount(async () => {
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/xterm/css/xterm.css'),
    ]);
    if (destroyed) return;
    xterm = new Terminal({
      cursorBlink: true,
      fontFamily:
        getComputedStyle(document.documentElement).getPropertyValue('--font-mono') || 'monospace',
      fontSize: 12.5,
      lineHeight: 1.15,
      scrollback: 5000,
      theme: theme(),
      allowProposedApi: false,
    });
    fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(host);
    xterm.onData((data) => {
      if (!hasControl) {
        notice = 'Take control of the session to type here.';
        return;
      }
      send({ type: 'input', data });
    });
    observer = new ResizeObserver(scheduleResize);
    observer.observe(host);
    scheme.addEventListener('change', retheme);
    connect();
  });

  // Lifecycle hooks must be registered synchronously, not after onMount's awaits.
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  const retheme = () => {
    if (xterm) xterm.options.theme = theme();
  };

  onDestroy(() => {
    destroyed = true;
    scheme.removeEventListener('change', retheme);
    if (retry) clearTimeout(retry);
    clearTimeout(resizeTimer);
    observer?.disconnect();
    socket?.close(1000, 'closed');
    xterm?.dispose();
  });

  $effect(() => {
    if (visible)
      requestAnimationFrame(() => {
        resize();
        xterm?.focus();
      });
  });
  $effect.pre(() => {
    if (hasControl && untrack(() => notice).startsWith('Take control')) notice = '';
  });
  // Regaining control: the pty may have been resized by another client meanwhile.
  watch(
    () => hasControl,
    (control) => {
      if (!control) return;
      sentSize = '';
      resize();
    },
  );
</script>

<div
  class="terminal-view"
  class:hidden={!visible}
  role="tabpanel"
  id="terminal-panel-{terminal.id}"
  aria-labelledby="terminal-tab-{terminal.id}"
>
  <div class="terminal-host" bind:this={host}></div>
  {#if notice}<p class="terminal-notice">{notice}</p>{/if}
</div>

<style>
  .terminal-view {
    position: relative;
    flex: 1 1 0;
    min-height: 0;
    padding: 6px 4px 4px 8px;
    background: var(--code-bg);
  }
  .terminal-view.hidden {
    display: none;
  }
  .terminal-host {
    width: 100%;
    height: 100%;
  }
  .terminal-notice {
    position: absolute;
    right: 12px;
    bottom: 10px;
    margin: 0;
    padding: 5px 10px;
    border-radius: 999px;
    color: var(--text-2);
    background: var(--bg-layer);
    box-shadow: var(--shadow-soft);
    font-size: 12px;
  }
  .terminal-host :global(.xterm-viewport) {
    background: transparent !important;
  }
</style>

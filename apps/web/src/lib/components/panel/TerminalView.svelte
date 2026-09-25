<script lang="ts">
  /**
   * One live terminal. xterm.js is loaded on first use (it is large); the
   * socket reconnects with backoff and the gateway replays scrollback, so the
   * view is rebuilt from scratch on every (re)connect.
   */
  import { onDestroy, onMount } from 'svelte';
  import { panelApi, type TerminalInfo } from '../../panel-api';
  import { getClientId } from '../../storage';

  export let sessionId: string;
  export let terminal: TerminalInfo;
  export let generation: number | undefined;
  export let hasControl: boolean;
  export let visible = true;
  export let onexit: (exitCode: number | null) => void = () => {};

  let host: HTMLDivElement;
  let notice = '';
  let destroyed = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let exited = terminal.exited;
  let xterm: import('@xterm/xterm').Terminal | undefined;
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

  function resize() {
    if (!fit || !xterm || !visible || !host?.offsetWidth) return;
    fit.fit();
    if (hasControl) send({ type: 'resize', cols: xterm.cols, rows: xterm.rows });
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
    observer = new ResizeObserver(() => resize());
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
    observer?.disconnect();
    socket?.close(1000, 'closed');
    xterm?.dispose();
  });

  $: if (visible)
    requestAnimationFrame(() => {
      resize();
      xterm?.focus();
    });
  $: if (hasControl && notice.startsWith('Take control')) notice = '';
</script>

<div class="terminal-view" class:hidden={!visible}>
  <div class="terminal-host" bind:this={host}></div>
  {#if notice}<p class="terminal-notice">{notice}</p>{/if}
</div>

<script lang="ts">
  /**
   * The session's browser (docs/history/browser.md): a live JPEG screencast of the
   * agent's tab, a takeover mode that forwards mouse and keyboard input (for
   * logins and forms), recordings, and a step-by-step replay of what the
   * agent did. Connected only while the tab is shown, since the node only
   * streams frames to viewers.
   */
  import {
    ArrowLeft,
    ArrowRight,
    Circle,
    Globe,
    Hand,
    History,
    RotateCw,
    Square,
    Undo2,
  } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import {
    panelApi,
    RECORDING_LOG,
    type BrowserFrame,
    type BrowserLogEntry,
    type BrowserViewState,
  } from '../../panel-api';
  import { getClientId } from '../../storage';
  import { watch } from '../../watch.svelte';

  interface Props {
    sessionId: string;
    generation: number | undefined;
    hasControl: boolean;
    active?: boolean;
  }

  let { sessionId, generation, hasControl, active = false }: Props = $props();

  let view = $state<BrowserViewState | null>(null);
  let frame = $state<{ src: string; width: number; height: number } | null>(null);
  let log: BrowserLogEntry[] = $state([]);
  let notice = $state('');
  let unavailable = $state('');
  let urlDraft = $state('');
  let editingUrl = $state(false);
  /** Replay: the log entry whose screenshot is shown instead of the live view. */
  let replay = $state<{ index: number; src: string | null } | null>(null);
  let showLog = $state(false);

  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let screen: HTMLImageElement | undefined = $state();
  let keys: HTMLTextAreaElement | undefined = $state();

  const userMode = $derived(view?.mode === 'user');
  const canDrive = $derived(userMode && hasControl);
  const recordings = $derived(
    log
      .map((entry) => RECORDING_LOG.exec(entry.action)?.[1])
      .filter((path): path is string => Boolean(path)),
  );

  function send(message: Record<string, unknown>) {
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ ...message, clientId: getClientId(), generation }));
  }
  /** Actions that change the browser need the session's control lease. */
  function act(message: Record<string, unknown>) {
    if (!hasControl || generation === undefined) {
      notice = 'Take control of the session to use the browser.';
      return;
    }
    send(message);
  }

  function onMessage(message: BrowserFrame) {
    switch (message.type) {
      case 'state':
        view = message.state;
        if (!editingUrl) urlDraft = message.state.url;
        if (!message.state.active) frame = null;
        break;
      case 'frame':
        frame = {
          src: `data:image/jpeg;base64,${message.data}`,
          width: message.width,
          height: message.height,
        };
        break;
      case 'log':
        log = message.entries;
        break;
      case 'log_entry':
        log = [...log.slice(-149), message.entry];
        break;
      case 'log_image':
        if (replay?.index === message.index)
          replay = {
            index: message.index,
            src: message.data ? `data:image/jpeg;base64,${message.data}` : null,
          };
        break;
      case 'error':
        notice =
          message.code === 'lost_control'
            ? 'Take control of the session to use the browser.'
            : message.code === 'agent_in_control'
              ? 'Press “Take over” first.'
              : message.message;
        break;
    }
  }

  function connect() {
    if (!active || socket || unavailable) return;
    const current = new WebSocket(panelApi.browserUrl(sessionId));
    socket = current;
    current.addEventListener('open', () => {
      attempts = 0;
      notice = '';
    });
    current.addEventListener('message', (event) => {
      try {
        onMessage(JSON.parse(String(event.data)) as BrowserFrame);
      } catch {
        /* ignore malformed frames */
      }
    });
    current.addEventListener('close', (event) => {
      if (socket !== current) return;
      socket = undefined;
      if (event.code === 4403) {
        unavailable = event.reason || 'The browser is not available on this node.';
        return;
      }
      if (!active) return;
      notice = 'Reconnecting…';
      retry = setTimeout(connect, Math.min(10_000, 500 * 2 ** attempts++));
    });
  }
  function disconnect() {
    clearTimeout(retry);
    const current = socket;
    socket = undefined;
    current?.close(1000, 'hidden');
  }

  watch(
    () => [sessionId, active] as const,
    ([, visible], previous) => {
      if (previous && previous[0] !== sessionId) {
        disconnect();
        view = null;
        frame = null;
        log = [];
        replay = null;
        unavailable = '';
      }
      if (visible) connect();
      else disconnect();
    },
    { immediate: true },
  );
  onDestroy(disconnect);

  // ---- input ----------------------------------------------------------------

  function point(event: MouseEvent) {
    const box = screen!.getBoundingClientRect();
    const width = frame?.width ?? view?.viewport.width ?? box.width;
    const height = frame?.height ?? view?.viewport.height ?? box.height;
    return {
      x: Math.round(((event.clientX - box.left) / box.width) * width),
      y: Math.round(((event.clientY - box.top) / box.height) * height),
    };
  }
  const buttonName = (button: number) =>
    button === 1 ? 'middle' : button === 2 ? 'right' : 'left';
  let lastMove = 0;

  function pointerDown(event: PointerEvent) {
    if (!canDrive || !screen) return;
    event.preventDefault();
    screen.setPointerCapture(event.pointerId);
    keys?.focus({ preventScroll: true });
    send({
      type: 'mouse',
      action: 'down',
      ...point(event),
      button: buttonName(event.button),
      clickCount: Math.max(1, event.detail),
    });
  }
  function pointerUp(event: PointerEvent) {
    if (!canDrive || !screen) return;
    event.preventDefault();
    send({
      type: 'mouse',
      action: 'up',
      ...point(event),
      button: buttonName(event.button),
      clickCount: Math.max(1, event.detail),
    });
  }
  function pointerMove(event: PointerEvent) {
    if (!canDrive || !screen || Date.now() - lastMove < 50) return;
    lastMove = Date.now();
    send({ type: 'mouse', action: 'move', ...point(event) });
  }
  function wheel(event: WheelEvent) {
    if (!canDrive || !screen) return;
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
    send({
      type: 'wheel',
      ...point(event),
      dx: event.deltaX * scale,
      dy: event.deltaY * scale,
    });
  }

  const SPECIAL = new Set([
    'Enter',
    'Tab',
    'Backspace',
    'Delete',
    'Escape',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  ]);
  /** Keys and chords go through as key presses; text (IME included) through `input`. */
  function keyDown(event: KeyboardEvent) {
    if (!canDrive || event.isComposing || event.key === 'Process') return;
    const chord = event.ctrlKey || event.metaKey || event.altKey;
    // Let the browser's own paste reach the textarea.
    if (chord && event.key.toLowerCase() === 'v') return;
    if (!SPECIAL.has(event.key) && !(chord && event.key.length === 1)) return;
    event.preventDefault();
    const modifiers = [
      event.ctrlKey && 'Control',
      event.altKey && 'Alt',
      event.shiftKey && (SPECIAL.has(event.key) || chord) && 'Shift',
      event.metaKey && 'Meta',
    ].filter(Boolean);
    send({ type: 'key', key: [...modifiers, event.key].join('+') });
  }
  function flushText() {
    if (!keys?.value) return;
    send({ type: 'text', text: keys.value });
    keys.value = '';
  }
  function textInput(event: Event) {
    if ((event as InputEvent).isComposing) return;
    flushText();
  }

  // ---- toolbar ----------------------------------------------------------------

  function navigate(event: SubmitEvent) {
    event.preventDefault();
    const url = urlDraft.trim();
    if (!url) return;
    editingUrl = false;
    if (!userMode) act({ type: 'takeover' });
    act({ type: 'navigate', url });
  }
  function openReplay(entry: BrowserLogEntry) {
    if (!entry.image) return;
    replay = { index: entry.index, src: null };
    send({ type: 'log_image', index: entry.index });
  }
  function step(delta: number) {
    if (!replay) return;
    const withImages = log.filter((entry) => entry.image);
    const at = withImages.findIndex((entry) => entry.index === replay!.index);
    const next = withImages[at + delta];
    if (next) openReplay(next);
  }
  const time = (at: number) =>
    new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const replayEntry = $derived(replay ? log.find((entry) => entry.index === replay!.index) : null);
</script>

<div class="browser-tab">
  {#if unavailable}
    <div class="browser-empty">
      <Globe size={22} />
      <p>{unavailable}</p>
      <p class="muted">Install Chromium on the node or set PIRC_BROWSER_EXECUTABLE.</p>
    </div>
  {:else}
    <div class="browser-bar">
      <span
        class="chip"
        class:status-running={!!view?.action}
        class:status-busy={userMode}
        title={view?.action ?? ''}
      >
        {#if userMode}
          {view?.agentWaiting ? 'Agent is waiting for you' : 'You are in control'}
        {:else if view?.action}
          {view.action}
        {:else}
          {view?.active ? 'Agent' : 'No browser open'}
        {/if}
      </span>
      <span class="spacer"></span>
      {#if view?.active}
        <button
          class="icon-button small"
          class:recording={!!view.recording}
          type="button"
          disabled={!hasControl}
          title={view.recording ? 'Stop recording' : 'Record video'}
          aria-label={view.recording ? 'Stop recording' : 'Record video'}
          onclick={() => act({ type: 'record', action: view?.recording ? 'stop' : 'start' })}
        >
          {#if view.recording}<Square size={14} />{:else}<Circle size={14} />{/if}
        </button>
      {/if}
      <button
        class="icon-button small"
        class:active={showLog}
        type="button"
        title="Activity and replay"
        aria-label="Activity and replay"
        aria-pressed={showLog}
        onclick={() => (showLog = !showLog)}><History size={15} /></button
      >
      {#if userMode}
        <button
          class="button small primary"
          type="button"
          disabled={!hasControl}
          onclick={() => act({ type: 'release' })}><Undo2 size={14} /> Return control</button
        >
      {:else if view?.active}
        <button
          class="button small"
          type="button"
          disabled={!hasControl}
          title={hasControl
            ? 'Pause the agent and use the browser yourself'
            : 'Take control of the session first'}
          onclick={() => act({ type: 'takeover' })}><Hand size={14} /> Take over</button
        >
      {/if}
    </div>

    {#if view?.handoff}
      <div class="browser-handoff" role="status">
        <strong>The agent needs you:</strong>
        {view.handoff}
      </div>
    {/if}

    <form class="browser-url" onsubmit={navigate}>
      <button
        class="icon-button small"
        type="button"
        disabled={!canDrive}
        aria-label="Back"
        onclick={() => act({ type: 'back' })}><ArrowLeft size={14} /></button
      >
      <button
        class="icon-button small"
        type="button"
        disabled={!canDrive}
        aria-label="Forward"
        onclick={() => act({ type: 'forward' })}><ArrowRight size={14} /></button
      >
      <button
        class="icon-button small"
        type="button"
        disabled={!canDrive}
        aria-label="Reload"
        onclick={() => act({ type: 'reload' })}><RotateCw size={14} /></button
      >
      <input
        type="text"
        inputmode="url"
        autocomplete="off"
        spellcheck="false"
        aria-label="Address"
        placeholder={hasControl ? 'Enter a URL to open it yourself' : 'Address'}
        readonly={!hasControl}
        bind:value={urlDraft}
        onfocus={() => (editingUrl = true)}
        onblur={() => {
          editingUrl = false;
          urlDraft = view?.url ?? '';
        }}
      />
    </form>

    {#if (view?.tabs.length ?? 0) > 1}
      <div class="browser-tabs" aria-label="Browser tabs">
        {#each view!.tabs as item (item.index)}
          <button
            type="button"
            class:active={item.active}
            disabled={!canDrive}
            title={item.url}
            onclick={() => act({ type: 'tab', index: item.index })}
            >{item.title || item.url || 'New tab'}</button
          >
        {/each}
      </div>
    {/if}

    <div class="browser-screen" class:driving={canDrive}>
      {#if replay}
        <div class="browser-replay-bar">
          <button
            class="icon-button small"
            type="button"
            aria-label="Previous step"
            onclick={() => step(-1)}><ArrowLeft size={14} /></button
          >
          <span title={replayEntry?.url}
            >{replayEntry ? `${time(replayEntry.at)} · ${replayEntry.action}` : ''}</span
          >
          <button
            class="icon-button small"
            type="button"
            aria-label="Next step"
            onclick={() => step(1)}><ArrowRight size={14} /></button
          >
          <button class="button small" type="button" onclick={() => (replay = null)}>Live</button>
        </div>
        {#if replay.src}<img class="screen" src={replay.src} alt="Browser at this step" />{:else}<p
            class="panel-empty"
          >
            Loading…
          </p>{/if}
      {:else if frame}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <img
          class="screen"
          bind:this={screen}
          src={frame.src}
          alt={view?.title ? `Browser: ${view.title}` : 'Browser'}
          draggable="false"
          onpointerdown={pointerDown}
          onpointerup={pointerUp}
          onpointermove={pointerMove}
          onwheel={wheel}
          oncontextmenu={(event) => canDrive && event.preventDefault()}
        />
        <textarea
          class="browser-keys"
          bind:this={keys}
          aria-label="Type into the browser"
          autocapitalize="off"
          autocomplete="off"
          spellcheck="false"
          onkeydown={keyDown}
          oninput={textInput}
          oncompositionend={flushText}
        ></textarea>
      {:else if view?.active}
        <p class="panel-empty">Waiting for the first frame…</p>
      {:else}
        <div class="browser-empty">
          <Globe size={22} />
          <p>
            The agent opens a browser when it uses web tools. You can watch it here, take over to
            log in or fill forms, and record videos.
          </p>
        </div>
      {/if}
      {#if notice}<p class="browser-notice">{notice}</p>{/if}
    </div>

    {#if showLog}
      <section class="browser-log" aria-label="Browser activity">
        {#if recordings.length}
          <h3>Recordings</h3>
          {#each recordings as path (path)}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video controls preload="metadata" src={panelApi.recordingUrl(sessionId, path)}></video>
            <a class="muted" href={panelApi.recordingUrl(sessionId, path)} download>{path}</a>
          {/each}
        {/if}
        <h3>Activity</h3>
        {#if !log.length}<p class="panel-empty">Nothing yet.</p>{/if}
        <ol>
          {#each [...log].reverse() as entry (entry.index)}
            <li>
              <button
                type="button"
                disabled={!entry.image}
                class:current={replay?.index === entry.index}
                title={entry.url}
                onclick={() => openReplay(entry)}
              >
                <span class="log-time">{time(entry.at)}</span>
                <span class="log-actor" class:user={entry.actor === 'user'}>{entry.actor}</span>
                <span class="log-action">{entry.action}</span>
              </button>
            </li>
          {/each}
        </ol>
      </section>
    {/if}
  {/if}
</div>

<style>
  .browser-tab {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
  }
  .browser-bar,
  .browser-url,
  .browser-tabs,
  .browser-replay-bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
  }
  .browser-bar {
    border-bottom: 1px solid var(--line);
  }
  .browser-bar .chip {
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .spacer {
    flex: 1;
  }
  .icon-button.recording {
    color: var(--danger);
  }
  .browser-handoff {
    margin: 8px 8px 0;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    color: var(--ink);
    background: var(--accent-soft);
    font-size: 13px;
    line-height: 1.45;
  }
  .browser-url input {
    flex: 1;
    min-width: 0;
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: 999px;
    color: var(--ink);
    background: var(--bg-layer);
    font-size: 12.5px;
  }
  .browser-tabs {
    overflow-x: auto;
    scrollbar-width: none;
  }
  .browser-tabs button {
    flex: none;
    max-width: 160px;
    height: 24px;
    padding: 0 8px;
    overflow: hidden;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--text-2);
    background: transparent;
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .browser-tabs button.active {
    color: var(--ink);
    background: var(--bg-active);
  }
  .browser-screen {
    position: relative;
    flex: none;
    padding: 0 8px 8px;
  }
  .screen {
    display: block;
    width: 100%;
    height: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: #fff;
    user-select: none;
    -webkit-user-drag: none;
  }
  .driving .screen {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
    cursor: default;
    touch-action: none;
  }
  /* Off-screen but focusable, so keyboards (and IMEs) type into the page. */
  .browser-keys {
    position: absolute;
    left: 8px;
    bottom: 8px;
    width: 1px;
    height: 1px;
    padding: 0;
    border: 0;
    opacity: 0;
    resize: none;
  }
  .browser-replay-bar {
    padding: 0 0 6px;
    font-size: 12px;
  }
  .browser-replay-bar span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--text-2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .browser-notice {
    margin: 6px 0 0;
    color: var(--text-2);
    font-size: 12px;
  }
  .browser-empty {
    display: grid;
    justify-items: center;
    gap: 10px;
    margin: auto;
    padding: 24px;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
    text-align: center;
  }
  .browser-empty p {
    max-width: 300px;
    margin: 0;
  }
  .browser-log {
    padding: 4px 8px 12px;
    border-top: 1px solid var(--line);
  }
  .browser-log h3 {
    margin: 8px 2px 4px;
    color: var(--muted);
    font-size: 11.5px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .browser-log video {
    width: 100%;
    border-radius: var(--radius-sm);
    background: #000;
  }
  .browser-log a {
    display: block;
    margin: 2px 0 8px;
    font-size: 11.5px;
    word-break: break-all;
  }
  .browser-log ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .browser-log li button {
    width: 100%;
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 4px 6px;
    border: 0;
    border-radius: var(--radius-sm);
    color: var(--ink);
    background: transparent;
    font-size: 12px;
    text-align: left;
  }
  .browser-log li button:not(:disabled):hover,
  .browser-log li button.current {
    background: var(--bg-hover);
  }
  .browser-log li button:disabled {
    color: var(--text-2);
    opacity: 1;
  }
  .log-time {
    flex: none;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .log-actor {
    flex: none;
    color: var(--accent);
    font-size: 11px;
  }
  .log-actor.user {
    color: var(--warning, #b7791f);
  }
  .log-action {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

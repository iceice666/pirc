<script lang="ts">
  import {
    Archive,
    ArchiveRestore,
    Hash,
    Menu,
    Paperclip,
    Plus,
    SendHorizontal,
    SquareTerminal,
    X,
  } from '@lucide/svelte';
  import { onMount, tick } from 'svelte';
  import { registerPwa } from '../../pwa';
  import { rooms as defaultRooms, type RoomsState } from '../../rooms.svelte';
  import { trackViewportHeight } from '../../viewport';
  import RoomMessageRow from './RoomMessageRow.svelte';

  interface Props {
    /** Tests pass their own. */
    store?: RoomsState;
  }

  let { store: rooms = defaultRooms }: Props = $props();

  let draft = $state('');
  let files = $state<File[]>([]);
  let sending = $state(false);
  let sendError = $state('');
  let newRoomName = $state('');
  let creating = $state(false);
  let moveTarget = $state('');
  /** Phone: the room list covers the room. */
  let listOpen = $state(false);
  let scroller: HTMLElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();
  let now = $state(Date.now());

  const current = $derived(rooms.current);
  const typingNow = $derived(rooms.typingIn(rooms.currentId, now));
  /** Faces by id until plan 10 lists them: only the host exists. */
  const FACES: Record<string, string> = { host: 'pirc' };
  const thinkingNow = $derived(
    rooms.thinkingIn(rooms.currentId).map((face) => FACES[face] ?? face),
  );
  const otherRooms = $derived(rooms.rooms.filter((room) => room.id !== rooms.currentId));

  onMount(() => {
    const removePwa = registerPwa(() => {});
    const removeViewport = trackViewportHeight();
    void rooms.start();
    const clock = setInterval(() => (now = Date.now()), 1000);
    const visible = () => {
      if (document.visibilityState === 'visible') void rooms.markRead();
    };
    document.addEventListener('visibilitychange', visible);
    // A notification clicked while this window is open (public/sw.js).
    const onWorkerMessage = (event: MessageEvent) => {
      const roomId = event.data?.type === 'OPEN_TARGET' ? event.data.target?.roomId : undefined;
      if (typeof roomId === 'string') void open(roomId);
    };
    navigator.serviceWorker?.addEventListener('message', onWorkerMessage);
    return () => {
      removePwa();
      removeViewport();
      clearInterval(clock);
      document.removeEventListener('visibilitychange', visible);
      navigator.serviceWorker?.removeEventListener('message', onWorkerMessage);
      rooms.stop();
    };
  });

  /** Follow new messages while the view is at the bottom. */
  let stuck = true;
  function onScroll() {
    if (!scroller) return;
    stuck = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    if (scroller.scrollTop < 40 && rooms.hasMore) void older();
  }
  $effect(() => {
    void rooms.messages.length;
    void rooms.currentId;
    if (!stuck) return;
    void tick().then(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  });

  async function older() {
    if (!scroller) return;
    const before = scroller.scrollHeight;
    await rooms.loadOlder();
    await tick();
    scroller.scrollTop += scroller.scrollHeight - before;
  }

  async function open(roomId: string) {
    listOpen = false;
    stuck = true;
    draft = '';
    files = [];
    await rooms.open(roomId);
  }

  /**
   * Messages go out one after another in the order they were written: people
   * send several short ones in a row (decision #16), so the composer clears
   * at once and never waits for the previous one.
   */
  let outbox: Promise<void> = Promise.resolve();
  function send(immediate: boolean) {
    const text = draft;
    const attached = files;
    if (!text.trim() && !attached.length) return;
    draft = '';
    files = [];
    stuck = true;
    sendError = '';
    sending = true;
    const sent = outbox.then(async () => {
      try {
        await rooms.send(text, { immediate, files: attached });
      } catch (error) {
        sendError = error instanceof Error ? error.message : 'Could not send.';
        // Give the words back unless something new was written meanwhile.
        if (!draft) draft = text;
        if (!files.length) files = attached;
      }
    });
    outbox = sent;
    void sent.then(() => {
      if (outbox === sent) sending = false;
    });
    return sent;
  }

  function onKeydown(event: KeyboardEvent) {
    // An IME composing (Chinese, Japanese) uses Enter to pick characters.
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
    if (event.shiftKey) return;
    event.preventDefault();
    void send(event.metaKey || event.ctrlKey);
  }

  async function createRoom(event: SubmitEvent) {
    event.preventDefault();
    if (!newRoomName.trim()) return;
    try {
      await rooms.createRoom(newRoomName);
      newRoomName = '';
      creating = false;
    } catch (error) {
      rooms.error = error instanceof Error ? error.message : 'Could not create the room.';
    }
  }

  async function moveHere() {
    if (!moveTarget) return;
    const target = moveTarget;
    moveTarget = '';
    await rooms.moveTo(target);
  }
</script>

<div class="rooms" class:list-open={listOpen}>
  <nav class="list" aria-label="Rooms">
    <div class="list-head">
      <a class="brand" href="/" aria-label="pirc">pirc</a>
      <button
        type="button"
        class="icon"
        aria-label="New room"
        title="New room"
        onclick={() => (creating = !creating)}><Plus size={18} /></button
      >
    </div>
    {#if creating}
      <form class="new-room" onsubmit={createRoom}>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          aria-label="Room name"
          placeholder="Room name"
          maxlength="80"
          bind:value={newRoomName}
          autofocus
        />
      </form>
    {/if}
    <ul>
      {#each rooms.rooms as room (room.id)}
        <li>
          <button
            type="button"
            class="room"
            class:chosen={room.id === rooms.currentId}
            class:unread={room.unread > 0}
            aria-current={room.id === rooms.currentId ? 'page' : undefined}
            onclick={() => open(room.id)}
          >
            <Hash size={16} />
            <span class="room-name">{room.name}</span>
            {#if room.waiting}<span class="waiting" title="Waiting for your reply">Your turn</span
              >{/if}
            {#if room.unread > 0 && room.id !== rooms.currentId}
              <span class="dot" aria-label="{room.unread} unread"></span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
    <a class="engine" href="/engine"><SquareTerminal size={16} />Engine</a>
  </nav>

  <main class="room-view" aria-label={current ? `#${current.name}` : 'Room'}>
    <header class="room-head">
      <button
        type="button"
        class="icon phone-only"
        aria-label="Rooms"
        onclick={() => (listOpen = true)}><Menu size={18} /></button
      >
      <h1><Hash size={18} />{current?.name ?? rooms.currentId}</h1>
      {#if current?.archivedAt}<span class="badge">Archived</span>{/if}
      <span class="spacer"></span>
      <span
        class="presence"
        class:thinking={thinkingNow.length > 0}
        role="status"
        title={thinkingNow.length ? 'pirc is thinking' : 'pirc is here'}
        ><span class="presence-dot" aria-hidden="true"></span>pirc<span class="sr-only"
          >{thinkingNow.length ? ' is thinking' : ' is here'}</span
        ></span
      >
      {#if rooms.connection !== 'connected' && !rooms.loading}
        <span class="badge" role="status">{rooms.connection}</span>
      {/if}
      {#if current && current.kind !== 'general'}
        <button
          type="button"
          class="icon"
          aria-label={current.archivedAt ? 'Unarchive' : 'Archive'}
          title={current.archivedAt ? 'Unarchive' : 'Archive'}
          onclick={() => rooms.setArchived(current.id, !current.archivedAt)}
          >{#if current.archivedAt}<ArchiveRestore size={18} />{:else}<Archive
              size={18}
            />{/if}</button
        >
      {/if}
      {#if current && !current.archivedAt && otherRooms.length}
        <select aria-label="Continue in another room" bind:value={moveTarget} onchange={moveHere}>
          <option value="">Continue in…</option>
          {#each otherRooms as room (room.id)}
            <option value={room.id}>#{room.name}</option>
          {/each}
        </select>
      {/if}
    </header>

    {#if rooms.pinned.length}
      <div class="pinned" aria-label="Pinned">
        {#each rooms.pinned as message (message.id)}
          <span class="pinned-item">📌 {message.body.text ?? 'attachment'}</span>
        {/each}
      </div>
    {/if}

    <div class="messages" bind:this={scroller} onscroll={onScroll}>
      {#if rooms.error}
        <p class="error" role="alert">{rooms.error}</p>
      {:else if !rooms.loading && !rooms.messages.length}
        <p class="empty">Nothing here yet. Say something.</p>
      {/if}
      {#each rooms.messages as message, index (message.id)}
        <RoomMessageRow
          {message}
          previous={rooms.messages[index - 1]}
          onopenroom={open}
          onpin={(item, pinned) => rooms.pin(item, pinned)}
        />
      {/each}
    </div>

    <div class="typing" aria-live="polite">
      {#if thinkingNow.length}{thinkingNow.join(', ')} is thinking…{/if}
      {#if typingNow.length}{typingNow.join(', ')}
        {typingNow.length === 1 ? 'is' : 'are'} typing…{/if}
    </div>

    {#if current && !current.archivedAt}
      <form
        class="composer"
        onsubmit={(event) => {
          event.preventDefault();
          void send(false);
        }}
      >
        {#if files.length}
          <ul class="files">
            {#each files as file, index (index)}
              <li>
                {file.name}
                <button
                  type="button"
                  class="icon"
                  aria-label="Remove {file.name}"
                  onclick={() => (files = files.filter((_, at) => at !== index))}
                  ><X size={14} /></button
                >
              </li>
            {/each}
          </ul>
        {/if}
        <div class="compose-row">
          <button
            type="button"
            class="icon"
            aria-label="Attach files"
            title="Attach files"
            onclick={() => fileInput?.click()}><Paperclip size={18} /></button
          >
          <input
            class="hidden"
            type="file"
            multiple
            bind:this={fileInput}
            onchange={(event) => {
              files = [...files, ...(event.currentTarget.files ?? [])];
              event.currentTarget.value = '';
            }}
          />
          <textarea
            aria-label="Message #{current.name}"
            placeholder="Message #{current.name}"
            rows="1"
            bind:value={draft}
            oninput={() => rooms.keystroke()}
            onkeydown={onKeydown}
          ></textarea>
          <button
            type="submit"
            class="icon send"
            aria-label="Send"
            title="Send (Enter) · Send now (⌘/Ctrl+Enter)"
            aria-busy={sending}
            disabled={!draft.trim() && !files.length}><SendHorizontal size={18} /></button
          >
        </div>
        {#if sendError}<p class="error" role="alert">{sendError}</p>{/if}
      </form>
    {:else if current?.archivedAt}
      <p class="archived-note">This room is archived. Unarchive it to write here.</p>
    {/if}
  </main>
</div>

<style>
  .rooms {
    display: grid;
    grid-template-columns: 248px 1fr;
    height: var(--viewport-height, 100dvh);
    background: var(--bg);
  }
  .list {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--line);
    background: var(--bg-sidebar);
  }
  .list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 12px 8px 16px;
  }
  .brand {
    font-weight: 700;
    color: var(--ink);
    text-decoration: none;
  }
  .new-room {
    padding: 0 12px 8px;
  }
  .new-room input {
    width: 100%;
    padding: 6px 8px;
    border: 1px solid var(--line-dark);
    border-radius: var(--radius-sm);
    background: var(--input);
    color: var(--ink);
    font: inherit;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .list ul {
    flex: 1;
    overflow-y: auto;
    padding: 0 8px;
  }
  .room {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--muted);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .room:hover {
    background: var(--bg-hover);
  }
  .room.chosen {
    background: var(--bg-active);
    color: var(--ink);
  }
  .room.unread {
    color: var(--ink);
    font-weight: 600;
  }
  .room-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ink);
  }
  .waiting {
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--warning-soft);
    color: var(--warning);
    font-size: 11px;
    font-weight: 600;
  }
  .engine {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 12px 16px;
    border-top: 1px solid var(--line);
    color: var(--muted);
    text-decoration: none;
  }
  .room-view {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .room-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--line);
  }
  h1 {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 0;
    font-size: 16px;
  }
  .spacer {
    flex: 1;
  }
  .badge {
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--bg-subtle);
    color: var(--muted);
    font-size: 12px;
  }
  .pinned {
    display: flex;
    gap: 12px;
    padding: 6px 16px;
    overflow-x: auto;
    border-bottom: 1px solid var(--line);
    font-size: 13px;
    color: var(--text-2);
    white-space: nowrap;
  }
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px 0;
  }
  .empty,
  .archived-note {
    padding: 16px 20px;
    color: var(--muted);
  }
  .error {
    margin: 4px 20px;
    color: var(--danger);
  }
  .presence {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--muted);
  }
  .presence-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--success);
  }
  .presence.thinking .presence-dot {
    background: var(--accent);
    animation: thinking 1.2s ease-in-out infinite;
  }
  @keyframes thinking {
    50% {
      opacity: 0.3;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .presence.thinking .presence-dot {
      animation: none;
    }
  }
  .typing {
    min-height: 20px;
    padding: 0 20px;
    font-size: 12px;
    color: var(--muted);
  }
  .composer {
    margin: 0 16px 16px;
    border: 1px solid var(--line-dark);
    border-radius: var(--radius-md);
    background: var(--input);
  }
  .compose-row {
    display: flex;
    align-items: flex-end;
    gap: 4px;
    padding: 6px;
  }
  textarea {
    flex: 1;
    min-height: 24px;
    max-height: 40vh;
    padding: 6px 4px;
    border: 0;
    background: none;
    color: var(--ink);
    font: inherit;
    resize: none;
    field-sizing: content;
    outline: none;
  }
  .files {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 8px 0;
  }
  .files li {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 4px 2px 8px;
    border-radius: var(--radius-sm);
    background: var(--bg-subtle);
    font-size: 13px;
  }
  .hidden {
    display: none;
  }
  .icon {
    display: grid;
    place-items: center;
    padding: 6px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
  .icon:hover {
    background: var(--bg-hover);
    color: var(--ink);
  }
  .send:not(:disabled) {
    color: var(--accent);
  }
  .send:disabled {
    opacity: 0.5;
    cursor: default;
  }
  select {
    padding: 4px 6px;
    border: 1px solid var(--line-dark);
    border-radius: var(--radius-sm);
    background: var(--input);
    color: var(--ink);
    font: inherit;
  }
  .phone-only {
    display: none;
  }
  @media (max-width: 650px) {
    .rooms {
      grid-template-columns: 1fr;
    }
    .list {
      display: none;
    }
    .list-open .list {
      position: fixed;
      inset: 0;
      z-index: 30;
      display: flex;
    }
    .phone-only {
      display: grid;
    }
  }
</style>

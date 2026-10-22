<script lang="ts">
  import {
    Archive,
    ArchiveRestore,
    Bell,
    BellOff,
    ChevronRight,
    Hash,
    Paperclip,
    Plus,
    SendHorizontal,
    Settings,
    SquareTerminal,
    Users,
    X,
  } from '@lucide/svelte';
  import { onMount, tick } from 'svelte';
  import {
    completeMention,
    HOST_FACE_ID,
    mentionAt,
    mentionMatches,
    roomFace,
    type Face,
  } from '../../faces';
  import { listFocus, rovingFocus } from '../../a11y';
  import { registerPwa } from '../../pwa';
  import { watch } from '../../watch.svelte';
  import type { RoomView } from '../../rooms';
  import { rooms as defaultRooms, roomFromUrl, type RoomsState } from '../../rooms.svelte';
  import { mutedRooms, setMuted, syncMuted } from '../../mute';
  import { loadRoomDraft, saveRoomDraft } from '../../storage';
  import SettingsDialog, { type SettingsTab } from '../dialogs/SettingsDialog.svelte';
  import MobileTabs, { type MobileTab, type MobileTabId } from '../MobileTabs.svelte';
  import { trackViewportHeight } from '../../viewport';
  import FacePanel from './FacePanel.svelte';
  import MembersPanel from './MembersPanel.svelte';
  import RoomMessageRow from './RoomMessageRow.svelte';
  import RoomSources from './RoomSources.svelte';
  import ThreadPanel from './ThreadPanel.svelte';

  interface Props {
    /** Tests pass their own. */
    store?: RoomsState;
  }

  let { store: rooms = defaultRooms }: Props = $props();

  /** Each room keeps what was being written in it. */
  let draftRoom = roomFromUrl() ?? 'general';
  let draft = $state(loadRoomDraft(draftRoom));
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
  $effect(() => {
    const roomId = rooms.currentId;
    if (roomId === draftRoom) return;
    draftRoom = roomId;
    draft = loadRoomDraft(roomId);
    files = [];
  });
  $effect(() => saveRoomDraft(draftRoom, draft));
  const typingNow = $derived(rooms.typingIn(rooms.currentId, now));
  /** A face's name; the host is pirc until the faces are loaded. */
  const faceName = (id: string) => rooms.face(id)?.name ?? (id === HOST_FACE_ID ? 'pirc' : id);
  const thinkingNow = $derived(rooms.thinkingIn(rooms.currentId).map(faceName));
  /** Who answers here when nobody is named (plan 10). */
  const here = $derived(roomFace(rooms.faces, rooms.currentId)?.name ?? faceName(HOST_FACE_ID));
  /** Beside the room: the members, or one face's page (a thread comes first). */
  let side = $state<'members' | 'face' | null>(null);
  let faceId = $state('');
  const shownFace = $derived<Face | undefined>(side === 'face' ? rooms.face(faceId) : undefined);
  const sideOpen = $derived(!rooms.threadId && (side === 'members' || !!shownFace));

  function openFace(id: string) {
    faceId = id;
    side = 'face';
  }

  /** A worker's question still waiting here: the newest, shown above the composer. */
  const asking = $derived(
    [...rooms.messages]
      .reverse()
      .find(
        (message) => message.kind === 'question' && message.body.question?.status === 'pending',
      ),
  );
  const askingTitle = $derived(asking?.body.question?.request.title);
  function jumpTo(messageId: string) {
    stuck = false;
    document
      .getElementById('message-' + messageId)
      ?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }

  /**
   * Screen readers hear each finished message from someone else once, from a
   * separate live region, not every streamed piece of the log.
   */
  let announcement = $state('');
  const lastHeard = $derived.by(() => {
    const last = rooms.messages[rooms.messages.length - 1];
    if (!last || last.body.streaming || last.kind === 'progress') return undefined;
    if (last.speaker === 'user' && last.user === rooms.user) return undefined;
    return last;
  });
  let announcedRoom = '';
  watch(
    () => lastHeard?.id,
    (id) => {
      const message = lastHeard;
      // Not what a room shows as it opens.
      if (rooms.currentId !== announcedRoom) {
        announcedRoom = rooms.currentId;
        return;
      }
      if (!id || !message) return;
      const who =
        message.speaker === 'user'
          ? (message.user ?? 'someone')
          : faceName(message.speaker.replace(/^face:/, ''));
      const text = message.body.text ?? 'an attachment';
      announcement = `${who}: ${text.length > 280 ? `${text.slice(0, 280)}…` : text}`;
    },
  );

  /** The room above or below the open one in the list (Alt+ArrowUp/Down). */
  function stepRoom(by: number) {
    const list = rooms.rooms;
    const at = list.findIndex((room) => room.id === rooms.currentId);
    const next = list[at === -1 ? 0 : (at + by + list.length) % list.length];
    if (next && next.id !== rooms.currentId) void open(next.id);
  }
  function onWindowKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || settingsOpen) return;
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      stepRoom(event.key === 'ArrowUp' ? -1 : 1);
    } else if (event.key === 'Escape' && !matches.length) {
      if (rooms.threadId) rooms.closeThread();
      else if (side) side = null;
      else if (listOpen) listOpen = false;
    }
  }
  /** The one room-list row in the tab order: the open room, or the first. */
  const tabRoom = $derived(
    [...rooms.rooms, ...rooms.archived].some((room) => room.id === rooms.currentId)
      ? rooms.currentId
      : rooms.rooms[0]?.id,
  );

  /** The archived rooms, folded under the list. */
  let showArchived = $state(false);
  async function toggleArchived() {
    showArchived = !showArchived;
    if (showArchived) await rooms.loadArchived().catch(() => {});
  }

  /** Settings, the same dialog as the engine's. */
  let settingsOpen = $state(false);
  let settingsTab = $state<SettingsTab>('models');
  const roomNames = $derived(
    Object.fromEntries([...rooms.rooms, ...rooms.archived].map((room) => [room.id, room.name])),
  );
  function openSettings(tab: SettingsTab = 'models') {
    settingsTab = tab;
    settingsOpen = true;
  }

  /** Rooms muted on this device: no notifications from them here. */
  let muted = $state(mutedRooms());
  // Unmuted from Settings meanwhile.
  $effect(() => {
    if (!settingsOpen) muted = mutedRooms();
  });
  const mutedHere = $derived(muted.includes(rooms.currentId));

  /** Phone: the bottom tabs. A room is inside the Rooms tab. */
  const mobileTab = $derived<MobileTabId>(
    settingsOpen ? 'settings' : !listOpen && sideOpen ? 'members' : 'rooms',
  );
  const mobileTabs = $derived<MobileTab[]>([
    { id: 'rooms', badge: rooms.rooms.filter((room) => room.waiting).length },
    { id: 'members' },
    { id: 'engine', href: '/engine' },
    { id: 'settings' },
  ]);
  function pickTab(tab: MobileTabId) {
    if (tab === 'settings') openSettings();
    else if (tab === 'members') {
      listOpen = false;
      rooms.closeThread();
      side = 'members';
    } else if (tab === 'rooms') {
      side = null;
      listOpen = true;
    }
  }

  /** `@name` completion in the composer. */
  let textarea: HTMLTextAreaElement | undefined = $state();
  let caret = $state(0);
  let choice = $state(0);
  let mentionDismissed = $state(false);
  const mention = $derived(mentionAt(draft, caret));
  const matches = $derived(
    mention && !mentionDismissed ? mentionMatches(rooms.faces, mention.query) : [],
  );
  $effect(() => {
    void mention?.start;
    choice = 0;
  });

  function trackCaret() {
    caret = textarea?.selectionStart ?? draft.length;
  }

  async function pick(face: Face) {
    if (!mention) return;
    const done = completeMention(draft, caret, mention.start, face.name);
    draft = done.text;
    caret = done.caret;
    await tick();
    textarea?.focus();
    textarea?.setSelectionRange(done.caret, done.caret);
  }
  const otherRooms = $derived(rooms.rooms.filter((room) => room.id !== rooms.currentId));

  onMount(() => {
    const removePwa = registerPwa(() => {});
    const removeViewport = trackViewportHeight();
    void rooms.start();
    syncMuted();
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
    await rooms.open(roomId);
  }

  /**
   * Every file in the composer once: the same file twice is still one
   * attachment. A picture pasted again arrives as a new File (with a new
   * timestamp), so name, size and type are what identify it.
   */
  const fileKey = (file: File) => `${file.name}:${file.size}:${file.type}`;
  function addFiles(more: File[]) {
    const known = new Set(files.map(fileKey));
    const fresh = more.filter((file) => {
      const key = fileKey(file);
      if (known.has(key)) return false;
      known.add(key);
      return true;
    });
    if (fresh.length) files = [...files, ...fresh];
  }

  /**
   * ⌘/Ctrl+V in the composer: an image on the clipboard becomes an attachment,
   * the same way the paperclip does. Words still paste as words — a clipboard
   * with both (a copied page and its picture) keeps the words too — and an
   * image pasted twice is one attachment.
   */
  function onPaste(event: ClipboardEvent) {
    const data = event.clipboardData;
    if (!data) return;
    const images = [...data.items]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    if (!images.length) return;
    addFiles(images);
    // Only the image was on the clipboard: there is no text to paste.
    if (!data.getData('text/plain').trim()) event.preventDefault();
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
    if (event.isComposing || event.keyCode === 229) return;
    if (matches.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : matches.length - 1;
        choice = (choice + step) % matches.length;
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        void pick(matches[choice] ?? matches[0]!);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        mentionDismissed = true;
        return;
      }
    }
    if (event.key !== 'Enter') return;
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

{#snippet roomRow(room: RoomView)}
  <button
    type="button"
    class="room"
    class:chosen={room.id === rooms.currentId}
    class:unread={room.unread > 0}
    tabindex={room.id === tabRoom ? 0 : -1}
    aria-current={room.id === rooms.currentId ? 'page' : undefined}
    onclick={() => open(room.id)}
  >
    <Hash size={16} />
    <span class="room-name">{room.name}</span>
    {#if muted.includes(room.id)}<BellOff size={13} aria-label="Muted" />{/if}
    {#if room.waiting}<span class="waiting" title="Waiting for your reply">Your turn</span>{/if}
    {#if room.unread > 0 && room.id !== rooms.currentId}
      <span class="dot" aria-label="{room.unread} unread"></span>
    {/if}
  </button>
{/snippet}

<svelte:window onkeydown={onWindowKeydown} />

<div class="rooms" class:list-open={listOpen} class:thread-open={!!rooms.threadId || sideOpen}>
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
    <div
      class="list-scroll"
      use:rovingFocus={{ selector: 'button.room', orientation: 'vertical', wrap: false }}
    >
      <ul>
        {#each rooms.rooms as room (room.id)}
          <li>{@render roomRow(room)}</li>
        {/each}
      </ul>
      <button type="button" class="fold" aria-expanded={showArchived} onclick={toggleArchived}
        ><ChevronRight size={14} />Archived</button
      >
      {#if showArchived}
        <ul class="archived" aria-label="Archived rooms">
          {#each rooms.archived as room (room.id)}
            <li>{@render roomRow(room)}</li>
          {:else}
            <li class="none">No archived rooms.</li>
          {/each}
        </ul>
      {/if}
    </div>
    <div class="list-foot">
      <a class="engine" href="/engine"><SquareTerminal size={16} />Engine</a>
      <button type="button" class="engine" onclick={() => openSettings()}
        ><Settings size={16} />Settings</button
      >
    </div>
  </nav>

  <main class="room-view" aria-label={current ? `#${current.name}` : 'Room'}>
    <header class="room-head">
      <h1><Hash size={18} />{current?.name ?? rooms.currentId}</h1>
      {#if current?.archivedAt}<span class="badge">Archived</span>{/if}
      <span class="spacer"></span>
      <span
        class="presence"
        class:thinking={thinkingNow.length > 0}
        role="status"
        title={thinkingNow.length ? `${thinkingNow.join(', ')} thinking` : `${here} is here`}
        ><span class="presence-dot" aria-hidden="true"></span>{thinkingNow.length
          ? thinkingNow.join(', ')
          : here}<span class="sr-only">{thinkingNow.length ? ' is thinking' : ' is here'}</span
        ></span
      >
      <button
        type="button"
        class="icon"
        aria-label="Members"
        title="Members"
        aria-pressed={sideOpen}
        onclick={() => (side = sideOpen ? null : 'members')}><Users size={18} /></button
      >
      {#if rooms.connection !== 'connected' && !rooms.loading}
        <span class="badge" role="status">{rooms.connection}</span>
      {/if}
      <button
        type="button"
        class="icon"
        aria-label={mutedHere ? 'Unmute this room on this device' : 'Mute this room on this device'}
        title={mutedHere ? 'Muted on this device' : 'Mute on this device'}
        aria-pressed={mutedHere}
        onclick={() => (muted = setMuted(rooms.currentId, !mutedHere))}
        >{#if mutedHere}<BellOff size={18} />{:else}<Bell size={18} />{/if}</button
      >
      {#if current && !current.archivedAt}
        <RoomSources
          roomName={current.name}
          scope={current.sourceScope}
          onchange={(scope) => rooms.setSources(current.id, scope)}
        />
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

    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="messages"
      role="log"
      aria-live="off"
      aria-label="Messages in #{current?.name ?? rooms.currentId}"
      tabindex="0"
      use:listFocus={{ selector: '[data-row]' }}
      bind:this={scroller}
      onscroll={onScroll}
    >
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
          onopenthread={(threadId) => void rooms.openThread(threadId)}
          faces={rooms.faces}
          onopenface={openFace}
          activity={rooms.threadActivity}
        />
      {/each}
    </div>

    {#if asking}
      <div class="asking" role="status">
        <span
          >{faceName(asking.speaker.replace(/^face:/, ''))} is waiting for your answer{askingTitle
            ? ': ' + askingTitle
            : ''}</span
        >
        <button type="button" class="link" onclick={() => jumpTo(asking.id)}>Show</button>
      </div>
    {/if}

    <p class="sr-only" role="status" aria-live="polite">{announcement}</p>
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
        {#if matches.length}
          <ul class="mentions" role="listbox" aria-label="Faces">
            {#each matches as face, index (face.id)}
              <li role="option" aria-selected={index === choice}>
                <button
                  type="button"
                  class:chosen={index === choice}
                  onmousedown={(event) => event.preventDefault()}
                  onclick={() => pick(face)}
                  >@{face.name}{#if face.bio}<span class="bio">{face.bio}</span>{/if}</button
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
              addFiles([...(event.currentTarget.files ?? [])]);
              event.currentTarget.value = '';
            }}
          />
          <textarea
            aria-label="Message #{current.name}"
            placeholder="Message #{current.name}"
            rows="1"
            bind:value={draft}
            bind:this={textarea}
            oninput={() => {
              rooms.keystroke();
              mentionDismissed = false;
              trackCaret();
            }}
            onkeyup={trackCaret}
            onclick={trackCaret}
            onkeydown={onKeydown}
            onpaste={onPaste}
            aria-autocomplete="list"
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
  {#if !rooms.threadId && shownFace}
    <FacePanel
      face={shownFace}
      faces={rooms.faces}
      presence={rooms.facePresence[shownFace.id]}
      rooms={rooms.rooms}
      onsave={(input) => rooms.updateFace(shownFace.id, input)}
      onback={() => (side = 'members')}
      onclose={() => (side = null)}
    />
  {:else if !rooms.threadId && side === 'members'}
    <MembersPanel
      faces={rooms.faces}
      presence={rooms.facePresence}
      roomId={rooms.currentId}
      onopen={openFace}
      onadd={async (name) => openFace((await rooms.createFace(name)).id)}
      onhide={(id, hidden) => rooms.updateFace(id, { hidden })}
      onclose={() => (side = null)}
    />
  {/if}
  {#if rooms.threadId}
    <ThreadPanel
      threadId={rooms.threadId}
      messages={rooms.threadMessages}
      workers={rooms.threadWorkers}
      error={rooms.threadError}
      user={rooms.user}
      onclose={() => rooms.closeThread()}
    />
  {/if}
  <MobileTabs tabs={mobileTabs} current={mobileTab} onpick={pickTab} />
</div>

<SettingsDialog bind:open={settingsOpen} bind:tab={settingsTab} {roomNames} />

<style>
  .rooms {
    display: grid;
    grid-template-columns: 248px 1fr;
    height: var(--viewport-height, 100dvh);
    background: var(--bg);
  }
  /* A worker's thread beside the room; plan 11 settles where it lives. */
  .rooms.thread-open {
    grid-template-columns: 248px 1fr minmax(280px, 380px);
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
  .list-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 8px 8px;
  }
  .fold {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    margin-top: 12px;
    padding: 4px 8px;
    border: 0;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    cursor: pointer;
  }
  .fold :global(svg) {
    transition: transform 0.15s;
  }
  .fold[aria-expanded='true'] :global(svg) {
    transform: rotate(90deg);
  }
  .archived .room {
    opacity: 0.7;
  }
  .none {
    padding: 4px 8px;
    color: var(--muted);
    font-size: 13px;
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
  .list-foot {
    display: flex;
    border-top: 1px solid var(--line);
  }
  .engine {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 6px;
    padding: 12px 16px;
    border: 0;
    background: none;
    color: var(--muted);
    font: inherit;
    text-decoration: none;
    cursor: pointer;
  }
  .engine:hover {
    color: var(--ink);
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
  .asking {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 16px 6px;
    padding: 6px 10px;
    border-left: 3px solid var(--warning);
    border-radius: var(--radius-sm);
    background: var(--warning-soft);
    color: var(--ink);
    font-size: 13px;
  }
  .asking span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
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
  .mentions {
    margin: 0;
    padding: 4px;
    border-bottom: 1px solid var(--line);
  }
  .mentions button {
    width: 100%;
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 4px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .mentions button.chosen,
  .mentions button:hover {
    background: var(--bg-hover);
  }
  .bio {
    overflow: hidden;
    color: var(--muted);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  @media (max-width: 650px) {
    .rooms,
    .rooms.thread-open {
      grid-template-columns: 1fr;
      /* Room for the bottom tabs. */
      padding-bottom: calc(56px + env(safe-area-inset-bottom));
    }
    .thread-open :global(.thread),
    .thread-open :global(.members),
    .thread-open :global(.face-page) {
      position: fixed;
      inset: 0 0 calc(56px + env(safe-area-inset-bottom));
      z-index: 25;
    }
    .list {
      display: none;
    }
    .list-open .list {
      position: fixed;
      inset: 0 0 calc(56px + env(safe-area-inset-bottom));
      z-index: 30;
      display: flex;
    }
    /* The tabs lead there. */
    .list-foot {
      display: none;
    }
  }
</style>

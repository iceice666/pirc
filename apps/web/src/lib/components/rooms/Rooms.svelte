<script lang="ts">
  import {
    Archive,
    ArchiveRestore,
    Bell,
    BellOff,
    ChevronDown,
    ChevronRight,
    Hash,
    MessageSquare,
    MoreHorizontal,
    Pin,
    Plus,
    Search,
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
  import { ApiError } from '../../http';
  import { listFocus, rovingFocus } from '../../a11y';
  import { registerPwa } from '../../pwa';
  import { watch } from '../../watch.svelte';
  import type { RoomMessage, RoomView, RoomsConnection } from '../../rooms';
  import { locale, t } from '../../i18n';
  import type { MessageKey } from '../../i18n/messages';
  import { rooms as defaultRooms, roomFromUrl, type RoomsState } from '../../rooms.svelte';
  import StatusGlyph, { glyphOf } from '../StatusGlyph.svelte';
  import { mutedRooms, setMuted, syncMuted } from '../../mute';
  import { loadRoomDraft, saveRoomDraft } from '../../storage';
  import SettingsDialog, { type SettingsTab } from '../dialogs/SettingsDialog.svelte';
  import MobileTabs, { type MobileTab, type MobileTabId } from '../MobileTabs.svelte';
  import { trackViewportHeight } from '../../viewport';
  import FacePanel from './FacePanel.svelte';
  import MembersPanel from './MembersPanel.svelte';
  import PinnedPanel from './PinnedPanel.svelte';
  import RoomMessageRow from './RoomMessageRow.svelte';
  import RoomSources from './RoomSources.svelte';
  import ThreadPanel from './ThreadPanel.svelte';
  import ThreadsPanel from './ThreadsPanel.svelte';

  interface Props {
    /** Tests pass their own. */
    store?: RoomsState;
  }

  let { store: rooms = defaultRooms }: Props = $props();

  /** The stream's state in the header, in the shared status words. */
  const CONNECTION: Record<RoomsConnection, MessageKey> = {
    connecting: 'rooms.connection.connecting',
    connected: 'common.status.connected',
    reconnecting: 'common.status.reconnecting',
    offline: 'common.status.offline',
  };

  /** Attachments drawn in the composer; the rest are counted. */
  const THUMBS = 3;

  /** Each room keeps what was being written in it. */
  let draftRoom = roomFromUrl() ?? 'general';
  let draft = $state(loadRoomDraft(draftRoom));
  let files = $state<File[]>([]);
  let sending = $state(false);
  let sendError = $state('');
  /** The gateway refused a send because the room is archived (409). */
  let refused = $state(false);
  let newRoomName = $state('');
  let creating = $state(false);
  let moveTarget = $state('');
  /** The room search: client-side, over the messages already loaded. */
  let search = $state('');
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
    search = '';
    refused = false;
  });
  $effect(() => saveRoomDraft(draftRoom, draft));
  const typingNow = $derived(rooms.typingIn(rooms.currentId, now));
  /** A face's name; the host is pirc until the faces are loaded. */
  const faceName = (id: string) => rooms.face(id)?.name ?? (id === HOST_FACE_ID ? 'pirc' : id);
  const thinkingNow = $derived(rooms.thinkingIn(rooms.currentId).map(faceName));
  /** The face that answers here when nobody is named (plan 10). */
  const roomFaceHere = $derived(roomFace(rooms.faces, rooms.currentId));
  /** Beside the room: members, one face's page, its threads or its pins. */
  let side = $state<'members' | 'face' | 'threads' | 'pinned' | null>(null);
  let faceId = $state('');
  const shownFace = $derived<Face | undefined>(side === 'face' ? rooms.face(faceId) : undefined);
  const sideOpen = $derived(
    !rooms.threadId &&
      (side === 'members' || side === 'threads' || side === 'pinned' || !!shownFace),
  );
  const roomNames = $derived(
    Object.fromEntries([...rooms.rooms, ...rooms.archived].map((room) => [room.id, room.name])),
  );

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
  const askingFace = $derived(asking ? faceName(asking.speaker.replace(/^face:/, '')) : '');
  const askingColor = $derived(
    asking ? (rooms.face(asking.speaker.replace(/^face:/, ''))?.color ?? undefined) : undefined,
  );
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
          ? (message.user ?? t('common.unknownUser'))
          : faceName(message.speaker.replace(/^face:/, ''));
      const text = message.body.text ?? t('common.attachment');
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
      if (search) search = '';
      else if (rooms.threadId) rooms.closeThread();
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

  /** The archived rooms, folded under the list; the fold says how many. */
  let showArchived = $state(false);
  async function toggleArchived() {
    showArchived = !showArchived;
    if (showArchived) await rooms.loadArchived().catch(() => {});
  }

  /**
   * The room search, over what is already loaded (the design's 180px field):
   * the words, a question's request, an attachment's name.
   */
  const query = $derived(search.trim().toLowerCase());
  function matchesQuery(message: RoomMessage): boolean {
    const text = [
      message.body.text ?? '',
      message.body.question?.request.title ?? '',
      message.body.question?.request.message ?? '',
      ...(message.body.attachments ?? []).map((attachment) => attachment.filename ?? ''),
    ]
      .join('\n')
      .toLowerCase();
    return text.includes(query);
  }
  const shown = $derived(query ? rooms.messages.filter(matchesQuery) : rooms.messages);

  const dayOf = (at: number) => new Date(at).toDateString();
  function dayLabel(at: number): string {
    const day = dayOf(at);
    const today = dayOf(Date.now());
    const yesterday = dayOf(Date.now() - 86_400_000);
    if (day === today) return t('rooms.log.today');
    if (day === yesterday) return t('rooms.log.yesterday');
    return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium' }).format(at);
  }

  /** The log's rows: where a day starts, and where the unread ones start. */
  const rows = $derived.by(() => {
    const list: {
      message: RoomMessage;
      previous: RoomMessage | undefined;
      dayStart: boolean;
      newStart: boolean;
    }[] = [];
    let day = '';
    let marked = false;
    for (const [index, message] of shown.entries()) {
      const startsDay = dayOf(message.createdAt) !== day;
      const newStart = !query && !marked && rooms.unreadMark > 0 && message.seq > rooms.unreadMark;
      if (newStart) marked = true;
      list.push({ message, previous: shown[index - 1], dayStart: startsDay, newStart });
      day = dayOf(message.createdAt);
    }
    return list;
  });

  /** Settings, the same dialog as the engine's. */
  let settingsOpen = $state(false);
  let settingsTab = $state<SettingsTab>('models');
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

  /** The list's second line: how many faces there are, when it knows. */
  const faceCount = $derived(rooms.faces.filter((face) => !face.archivedAt).length);
  const gatewayLine = $derived(
    faceCount
      ? `${t('rooms.list.gateway')} · ${faceCount === 1 ? t('rooms.list.oneFace') : t('rooms.list.faces', { count: faceCount })}`
      : t('rooms.list.gateway'),
  );

  onMount(() => {
    const removePwa = registerPwa(() => {});
    const removeViewport = trackViewportHeight();
    void rooms.start();
    // The fold's count, without opening it.
    void rooms.loadArchived().catch(() => {});
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
    search = '';
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

  /** A file's size in words ("3.2 kB"); the composer's second line. */
  function size(bytes: number): string {
    const units = ['byte', 'kilobyte', 'megabyte'] as const;
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return new Intl.NumberFormat(locale(), {
      style: 'unit',
      unit: units[unit]!,
      maximumFractionDigits: 1,
    }).format(value);
  }

  /** The tile's word for a file: `img`, `pdf`, or its extension. */
  function kindOf(file: File): string {
    if (file.type.startsWith('image/')) return 'img';
    const extension = file.name.split('.').pop();
    return extension && extension !== file.name ? extension.slice(0, 4).toLowerCase() : 'file';
  }

  /**
   * ⌘/Ctrl+V in the composer: an image on the clipboard becomes an attachment,
   * the same way the plus button does. Words still paste as words — a clipboard
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

  /** Files dragged onto the composer land in it, like a paste. */
  let dragging = $state(false);
  function onDragOver(event: DragEvent) {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    dragging = true;
  }
  function onDrop(event: DragEvent) {
    const dropped = [...(event.dataTransfer?.files ?? [])];
    dragging = false;
    if (!dropped.length) return;
    event.preventDefault();
    addFiles(dropped);
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
        // An archived room refuses the message (409): say so, and offer the way out.
        if (error instanceof ApiError && error.status === 409) {
          refused = true;
          return;
        }
        sendError = error instanceof Error ? error.message : t('rooms.composer.couldNotSend');
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
      rooms.error = error instanceof Error ? error.message : t('rooms.newRoom.couldNot');
    }
  }

  async function moveHere() {
    if (!moveTarget) return;
    const target = moveTarget;
    moveTarget = '';
    await rooms.moveTo(target);
  }

  async function unarchive() {
    if (!current) return;
    refused = false;
    await rooms.setArchived(current.id, false).catch((error) => {
      sendError = error instanceof Error ? error.message : t('rooms.action.archive');
    });
  }

  /** Escape in the search field clears it before anything else closes. */
  function onSearchKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !search) return;
    event.preventDefault();
    event.stopPropagation();
    search = '';
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
    {#if room.unread > 0}<span class="rail" aria-hidden="true"></span>{/if}
    <Hash size={18} />
    <span class="room-name">{room.name}</span>
    {#if muted.includes(room.id)}<BellOff size={13} aria-label={t('rooms.room.muted')} />{/if}
    {#if room.waiting}<span class="waiting" title={t('rooms.room.yourTurnTitle')}
        >{t('rooms.room.yourTurn')}</span
      >{/if}
    {#if room.unread > 0}
      <span class="count" aria-label={t('common.unread', { count: room.unread })}
        >{room.unread}</span
      >
    {/if}
  </button>
{/snippet}

<svelte:window onkeydown={onWindowKeydown} />

<div
  class="rooms"
  class:list-open={listOpen}
  class:side-open={sideOpen}
  class:thread-open={!!rooms.threadId}
>
  <nav class="list" aria-label={t('common.tab.rooms')}>
    <div class="list-head">
      <div class="identity">
        <a class="brand" href="/" aria-label="pirc">pirc</a>
        <span class="subtitle">{gatewayLine}</span>
      </div>
      <details class="server-menu">
        <summary aria-label={t('rooms.list.menu')} title={t('rooms.list.menu')}
          ><ChevronDown size={18} /></summary
        >
        <div class="pop">
          <button type="button" class="pop-row" onclick={() => (creating = !creating)}
            ><Plus size={16} aria-hidden="true" />{t('rooms.newRoom.title')}</button
          >
        </div>
      </details>
    </div>
    {#if creating}
      <form class="new-room" onsubmit={createRoom}>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          aria-label={t('rooms.newRoom.name')}
          placeholder={t('rooms.newRoom.name')}
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
      <div class="eyebrow section-label">{t('common.tab.rooms')}</div>
      <ul>
        {#each rooms.rooms as room (room.id)}
          <li>{@render roomRow(room)}</li>
        {/each}
      </ul>
      <button type="button" class="fold" aria-expanded={showArchived} onclick={toggleArchived}
        ><ChevronRight size={14} />{rooms.archived.length
          ? t('rooms.list.archivedCount', { count: rooms.archived.length })
          : t('common.archived')}</button
      >
      {#if showArchived}
        <ul class="archived" aria-label={t('rooms.list.archivedRooms')}>
          {#each rooms.archived as room (room.id)}
            <li>{@render roomRow(room)}</li>
          {:else}
            <li class="none">{t('rooms.list.noArchived')}</li>
          {/each}
        </ul>
      {/if}
    </div>
    <div class="list-foot">
      <a class="engine" href="/engine"><SquareTerminal size={18} />{t('common.tab.engine')}</a>
      <button type="button" class="engine" onclick={() => openSettings()}
        ><Settings size={18} />{t('common.tab.settings')}</button
      >
    </div>
  </nav>

  <main class="room-view" aria-label={current ? `#${current.name}` : t('rooms.header.room')}>
    <header class="room-head">
      <span class="head-hash" aria-hidden="true"><Hash size={22} /></span>
      <h1>{current?.name ?? rooms.currentId}</h1>
      <span class="rule" aria-hidden="true"></span>
      <p class="subtitle">
        <span
          >{current?.kind === 'general'
            ? t('rooms.header.kindGeneral')
            : t('rooms.header.kindTopic')}</span
        >
        {#if roomFaceHere}<span aria-hidden="true"> · </span><span
            class="face"
            style:color={roomFaceHere.color ?? undefined}>@{roomFaceHere.name}</span
          >{/if}
        {#if rooms.connection !== 'connected' && !rooms.loading}
          <span class="conn" role="status"
            ><StatusGlyph state={glyphOf(rooms.connection)} />{t(
              CONNECTION[rooms.connection],
            )}</span
          >
        {/if}
      </p>
      <div class="head-actions">
        <button
          type="button"
          class="icon"
          aria-label={t('rooms.header.threads')}
          title={t('rooms.header.threads')}
          aria-pressed={side === 'threads'}
          onclick={() => (side = side === 'threads' ? null : 'threads')}
          ><MessageSquare size={20} /></button
        >
        <button
          type="button"
          class="icon"
          aria-label={t('rooms.header.pinned')}
          title={t('rooms.header.pinned')}
          aria-pressed={side === 'pinned'}
          onclick={() => (side = side === 'pinned' ? null : 'pinned')}><Pin size={20} /></button
        >
        <button
          type="button"
          class="icon"
          aria-label={mutedHere ? t('rooms.mute.unmute') : t('rooms.mute.mute')}
          title={mutedHere ? t('rooms.mute.on') : t('rooms.mute.off')}
          aria-pressed={mutedHere}
          onclick={() => (muted = setMuted(rooms.currentId, !mutedHere))}
          >{#if mutedHere}<BellOff size={20} />{:else}<Bell size={20} />{/if}</button
        >
        <button
          type="button"
          class="icon"
          aria-label={t('rooms.members.title')}
          title={t('rooms.members.title')}
          aria-pressed={side === 'members'}
          onclick={() => (side = side === 'members' ? null : 'members')}><Users size={20} /></button
        >
        <label class="search">
          <span class="sr-only">{t('rooms.header.search', { room: current?.name ?? '' })}</span>
          <input
            type="search"
            placeholder={t('rooms.header.search', { room: current?.name ?? '' })}
            bind:value={search}
            onkeydown={onSearchKeydown}
          />
          {#if search}
            <button
              type="button"
              class="clear"
              aria-label={t('rooms.search.clear')}
              onclick={() => (search = '')}><X size={14} /></button
            >
          {:else}
            <Search size={16} aria-hidden="true" />
          {/if}
        </label>
        <details class="head-menu">
          <summary aria-label={t('rooms.header.menu')} title={t('rooms.header.menu')}
            ><MoreHorizontal size={20} /></summary
          >
          <div class="pop">
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
                class="pop-row"
                onclick={() => rooms.setArchived(current.id, !current.archivedAt)}
                >{#if current.archivedAt}<ArchiveRestore size={16} /><span
                    >{t('rooms.action.unarchive')}</span
                  >{:else}<Archive size={16} /><span>{t('rooms.action.archive')}</span>{/if}</button
              >
            {/if}
            {#if current && !current.archivedAt && otherRooms.length}
              <label class="move">
                <span class="section-label">{t('rooms.move.label')}</span>
                <select
                  aria-label={t('rooms.move.label')}
                  bind:value={moveTarget}
                  onchange={moveHere}
                >
                  <option value="">{t('rooms.move.placeholder')}</option>
                  {#each otherRooms as room (room.id)}
                    <option value={room.id}>#{room.name}</option>
                  {/each}
                </select>
              </label>
            {/if}
          </div>
        </details>
      </div>
    </header>

    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="messages"
      role="log"
      aria-live="off"
      aria-label={t('rooms.log.label', { room: current?.name ?? rooms.currentId })}
      tabindex="0"
      use:listFocus={{ selector: '[data-row]' }}
      bind:this={scroller}
      onscroll={onScroll}
    >
      {#if query}
        <p class="search-note" role="status">
          {shown.length
            ? t('rooms.search.matches', { count: shown.length })
            : t('rooms.search.none')}
        </p>
      {/if}
      {#if rooms.error}
        <p class="error" role="alert">{rooms.error}</p>
      {:else if rooms.loading && !rooms.messages.length}
        <div class="skeleton" aria-hidden="true">
          <span></span><span></span><span></span>
        </div>
        <p class="sr-only" role="status">{t('rooms.log.loading')}</p>
      {:else if !rooms.messages.length}
        <p class="empty">{t('rooms.log.empty')}</p>
      {/if}
      {#each rows as row (row.message.id)}
        {#if row.dayStart}
          <div class="day">{dayLabel(row.message.createdAt)}</div>
        {/if}
        {#if row.newStart}
          <div class="new" role="separator" aria-label={t('rooms.log.newTitle')}>
            <span class="sr-only">{t('rooms.log.newTitle')}</span>
            <span aria-hidden="true">{t('rooms.log.new')}</span>
          </div>
        {/if}
        <RoomMessageRow
          message={row.message}
          previous={row.previous}
          onopenroom={open}
          onpin={(item, pinned) => rooms.pin(item, pinned)}
          onopenthread={(threadId) => void rooms.openThread(threadId)}
          faces={rooms.faces}
          onopenface={openFace}
          activity={rooms.threadActivity}
        />
      {/each}
    </div>

    <p class="sr-only" role="status" aria-live="polite">{announcement}</p>
    <div class="typing" aria-live="polite">
      {#if thinkingNow.length}{t('rooms.typing.thinking', {
          names: thinkingNow.join(', '),
        })}{/if}
      {#if typingNow.length}{typingNow.length === 1
          ? t('rooms.typing.one', { names: typingNow.join(', ') })
          : t('rooms.typing.many', { names: typingNow.join(', ') })}{/if}
    </div>

    {#if current && (current.archivedAt || refused)}
      <div class="read-only" role="status">
        <span>{t('rooms.archived.note')}</span>
        <button type="button" class="button small" onclick={unarchive}
          >{t('rooms.action.unarchive')}</button
        >
      </div>
    {:else if current}
      <div class="compose-area">
        {#if asking}
          <div class="asking" role="status">
            <StatusGlyph state="waiting" />
            <span class="ask-text"
              ><span class="face" style:color={askingColor}>{askingFace}</span>{' '}{askingTitle
                ? t('rooms.asking.withTitle', { name: '', title: askingTitle }).trim()
                : t('rooms.asking.waiting', { name: '' }).trim()}</span
            >
            <button type="button" class="link" onclick={() => jumpTo(asking.id)}
              >{t('common.show')}</button
            >
          </div>
        {/if}
        <form
          class="composer"
          class:dragging
          onsubmit={(event) => {
            event.preventDefault();
            void send(false);
          }}
          ondragover={onDragOver}
          ondragleave={() => (dragging = false)}
          ondrop={onDrop}
        >
          {#if files.length}
            <ul class="files" aria-label={t('rooms.composer.attachments')}>
              {#each files.slice(0, THUMBS) as file (fileKey(file))}
                <li>
                  <span class="thumb" aria-hidden="true">{kindOf(file)}</span>
                  <span class="file-what"
                    ><span class="file-name">{file.name}</span><span class="file-sub"
                      >{size(file.size)}</span
                    ></span
                  >
                  <button
                    type="button"
                    class="icon"
                    aria-label={t('common.removeNamed', { name: file.name })}
                    onclick={() =>
                      (files = files.filter((item) => fileKey(item) !== fileKey(file)))}
                    ><X size={14} /></button
                  >
                </li>
              {/each}
              {#if files.length > THUMBS}
                <li class="more">
                  <span aria-hidden="true">+{files.length - THUMBS}</span>
                  <span class="sr-only"
                    >{t('rooms.composer.moreAttachments', { count: files.length - THUMBS })}</span
                  >
                </li>
              {/if}
            </ul>
          {/if}
          {#if matches.length}
            <ul class="mentions" role="listbox" aria-label={t('rooms.mentions.label')}>
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
              class="attach"
              aria-label={t('rooms.composer.attach')}
              title={t('rooms.composer.attach')}
              onclick={() => fileInput?.click()}><Plus size={16} /></button
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
              aria-label={t('rooms.composer.message', { room: current.name })}
              placeholder={t('rooms.composer.placeholder', { room: current.name })}
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
              class="send"
              aria-label={t('rooms.composer.send')}
              title={t('rooms.composer.sendTitle')}
              aria-busy={sending}
              disabled={!draft.trim() && !files.length}><SendHorizontal size={18} /></button
            >
          </div>
          {#if sendError}<p class="error send-error" role="alert">{sendError}</p>{/if}
        </form>
      </div>
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
      {roomNames}
      onopen={openFace}
      onadd={async (name) => openFace((await rooms.createFace(name)).id)}
      onhide={(id, hidden) => rooms.updateFace(id, { hidden })}
      onclose={() => (side = null)}
    />
  {:else if !rooms.threadId && side === 'threads'}
    <ThreadsPanel
      messages={rooms.messages}
      activity={rooms.threadActivity}
      onopen={(threadId) => void rooms.openThread(threadId)}
      onclose={() => (side = null)}
    />
  {:else if !rooms.threadId && side === 'pinned'}
    <PinnedPanel
      pinned={rooms.pinned}
      faces={rooms.faces}
      onjump={jumpTo}
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
  /* The design's three columns: 240px of rooms, the log, 248px beside it. */
  .rooms {
    display: grid;
    grid-template-columns: 240px 1fr;
    height: var(--viewport-height, 100dvh);
    background: var(--bg);
  }
  .rooms.side-open {
    grid-template-columns: 240px 1fr 248px;
  }
  /* A worker's thread beside the room; plan 11 settles where it lives. */
  .rooms.thread-open {
    grid-template-columns: 240px 1fr minmax(320px, 420px);
  }
  .list {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg-sidebar);
  }
  /* 52px header: the name, then the gateway and how many faces it has. */
  .list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    height: 52px;
    padding: 0 16px;
    border-bottom: 1px solid var(--line);
  }
  .identity {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .brand {
    color: var(--ink);
    font-size: 15px;
    font-weight: 600;
    text-decoration: none;
  }
  .subtitle {
    margin: 0;
    overflow: hidden;
    color: var(--faint);
    font-size: 12px;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .server-menu,
  .head-menu {
    position: relative;
  }
  .server-menu summary,
  .head-menu summary {
    display: grid;
    place-items: center;
    padding: 4px;
    border-radius: var(--radius-sm);
    color: var(--muted);
    cursor: pointer;
    list-style: none;
  }
  .server-menu summary::-webkit-details-marker,
  .head-menu summary::-webkit-details-marker {
    display: none;
  }
  .server-menu summary:hover,
  .head-menu summary:hover {
    background: var(--bg-hover);
    color: var(--ink);
  }
  .pop {
    position: absolute;
    right: 0;
    z-index: 20;
    width: 240px;
    margin-top: 4px;
    padding: 4px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--bg-layer);
    box-shadow: var(--shadow-pop);
  }
  .pop-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .pop-row:hover {
    background: var(--bg-hover);
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
    padding: 0 8px;
    list-style: none;
  }
  .list-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 8px;
  }
  .eyebrow {
    padding: 8px 8px 4px;
  }
  .fold {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-height: 32px;
    margin-top: 12px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--faint);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    text-align: left;
    cursor: pointer;
  }
  .fold:hover {
    background: var(--bg-hover);
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
  /* A 36px row: hash, name, and what waits there. */
  .room {
    position: relative;
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    padding: 0 8px;
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
    background: var(--bg-hover);
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
  /* The 4×8px marker on an unread row. */
  .rail {
    position: absolute;
    left: -8px;
    width: 4px;
    height: 8px;
    border-radius: 0 4px 4px 0;
    background: var(--ink);
  }
  .waiting {
    padding: 1px 7px;
    border-radius: 10px;
    background: var(--warning);
    color: var(--bg);
    font-size: 11px;
    font-weight: 700;
  }
  /* Unread is a red count, not a dot. */
  .count {
    min-width: 18px;
    padding: 0 5px;
    border-radius: 9px;
    background: var(--danger);
    color: white;
    font-size: 11px;
    font-weight: 700;
    text-align: center;
  }
  .list-foot {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
    background: var(--bg-footer);
    border-top: 1px solid var(--line);
  }
  .engine {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-2);
    font: inherit;
    font-size: 15px;
    font-weight: 500;
    text-decoration: none;
    cursor: pointer;
  }
  .engine:hover {
    background: var(--bg-hover);
    color: var(--ink);
  }
  .room-view {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--bg-room);
  }
  /* A 52px header: hash, name, a hairline, the subtitle, then the controls. */
  .room-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    min-height: 52px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--line);
  }
  .head-hash {
    display: inline-flex;
    color: var(--faint);
  }
  h1 {
    margin: 0;
    color: var(--ink);
    font-size: 16px;
    font-weight: 600;
  }
  .rule {
    width: 1px;
    height: 24px;
    background: var(--line-dark);
  }
  .room-head .subtitle {
    flex: 1 1 200px;
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    color: var(--muted);
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .subtitle .face {
    font-weight: 500;
  }
  .conn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: 8px;
    padding: 0 8px;
    border-radius: 999px;
    background: var(--bg-subtle);
    color: var(--muted);
    font-size: 12px;
  }
  .head-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    padding: 0;
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
  .icon[aria-pressed='true'] {
    background: var(--bg-hover);
    color: var(--ink);
  }
  /* The 180×30 search field, inset on the darker well. */
  .search {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 180px;
    height: 30px;
    padding: 0 8px;
    border-radius: var(--radius-sm);
    background: var(--code-bg);
    color: var(--faint);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
    outline: none;
  }
  .clear {
    display: grid;
    place-items: center;
    padding: 2px;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
  .clear:hover {
    color: var(--ink);
  }
  .head-menu .pop {
    width: 260px;
    padding: 8px;
  }
  .move {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 4px;
  }
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px 0 8px;
  }
  /* A hairline day divider, and the red line where unread ones start. */
  .day,
  .new {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 16px 12px;
    color: var(--faint);
    font-size: 12px;
    font-weight: 600;
  }
  .day::before,
  .day::after,
  .new::before,
  .new::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--bg-active);
  }
  .new {
    margin: 16px 16px 4px;
    color: var(--danger);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .new::before,
  .new::after {
    background: color-mix(in srgb, var(--danger) 60%, transparent);
  }
  .search-note {
    margin: 0 16px 8px;
    color: var(--muted);
    font-size: 12px;
  }
  /* A light skeleton for a log that is still loading. */
  .skeleton {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 8px 48px 8px 16px;
  }
  .skeleton span {
    height: 12px;
    border-radius: 6px;
    background: var(--bg-hover);
    animation: breathe 1.6s var(--ease) infinite;
  }
  .skeleton span:nth-child(2) {
    width: 70%;
    animation-delay: 0.2s;
  }
  .skeleton span:nth-child(3) {
    width: 45%;
    animation-delay: 0.4s;
  }
  @keyframes breathe {
    50% {
      opacity: 0.4;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .skeleton span {
      animation: none;
    }
  }
  .empty {
    padding: 16px 20px;
    color: var(--muted);
  }
  .error {
    margin: 4px 20px;
    color: var(--danger);
  }
  .typing {
    min-height: 20px;
    padding: 0 20px;
    font-size: 12px;
    color: var(--muted);
  }
  .compose-area {
    display: flex;
    flex-direction: column;
    margin: 0 16px 20px;
  }
  /* The asking strip is fused to the top of the composer. */
  .asking {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: -6px;
    padding: 6px 12px;
    border-radius: var(--radius-md) var(--radius-md) 0 0;
    background: var(--bg-sidebar);
    color: var(--muted);
    font-size: 13px;
  }
  .ask-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .asking .face {
    color: var(--text-2);
    font-weight: 600;
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent-ink);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  /* A filled composer, 48px high, with a round attach and an accent send. */
  .composer {
    display: flex;
    flex-direction: column;
    border-radius: var(--radius-md);
    background: var(--bg-composer);
  }
  .composer.dragging {
    box-shadow: inset 0 0 0 2px var(--accent);
  }
  .compose-row {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 48px;
    padding: 0 12px;
  }
  textarea {
    flex: 1;
    min-width: 0;
    min-height: 28px;
    max-height: 40vh;
    padding: 4px 0;
    border: 0;
    background: none;
    color: var(--text-2);
    font: inherit;
    resize: none;
    field-sizing: content;
    outline: none;
  }
  .attach {
    flex: none;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--muted);
    color: var(--bg-composer);
    cursor: pointer;
  }
  .attach:hover {
    background: var(--ink);
  }
  .send {
    flex: none;
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent);
    cursor: pointer;
  }
  .send:disabled {
    background: none;
    color: var(--muted);
    opacity: 0.5;
    cursor: default;
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
    gap: 8px;
    margin: 0;
    padding: 10px 12px 2px;
  }
  .files li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px;
    border-radius: var(--radius-md);
    background: var(--bg-sidebar);
    box-shadow: inset 0 0 0 1px var(--line);
    font-size: 13px;
  }
  .thumb {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: var(--radius-sm);
    background: var(--code-bg);
    color: var(--faint);
    font-family: var(--font-mono);
    font-size: 10px;
  }
  .file-what {
    display: flex;
    flex-direction: column;
    max-width: 160px;
    line-height: 1.25;
  }
  .file-name {
    overflow: hidden;
    color: var(--text-2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-sub {
    color: var(--faint);
    font-size: 11px;
  }
  .files .more {
    align-self: center;
    padding: 6px 10px;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .hidden {
    display: none;
  }
  .files .icon {
    width: 28px;
    height: 28px;
    color: var(--muted);
  }
  .send-error {
    margin: 4px 12px 8px;
  }
  /* An archived room says why it takes nothing, with the way out. */
  .read-only {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0 16px 20px;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    background: var(--bg-sidebar);
    box-shadow: inset 0 0 0 1px var(--line);
    color: var(--muted);
    font-size: 13px;
  }
  .read-only span {
    flex: 1;
    min-width: 0;
  }
  select {
    padding: 6px 8px;
    border: 1px solid var(--line-dark);
    border-radius: var(--radius-sm);
    background: var(--input);
    color: var(--ink);
    font: inherit;
  }
  @media (max-width: 650px) {
    .rooms,
    .rooms.side-open,
    .rooms.thread-open {
      grid-template-columns: 1fr;
      /* Room for the bottom tabs. */
      padding-bottom: calc(56px + env(safe-area-inset-bottom));
    }
    .thread-open :global(.thread),
    .thread-open :global(.members),
    .thread-open :global(.panel),
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
    /* The room's controls wrap under its name; the search stays reachable. */
    .room-head .subtitle,
    .room-head .rule {
      display: none;
    }
    .head-actions {
      flex: 1 1 100%;
      flex-wrap: wrap;
    }
    .search {
      flex: 1 1 140px;
      width: auto;
    }
  }
</style>

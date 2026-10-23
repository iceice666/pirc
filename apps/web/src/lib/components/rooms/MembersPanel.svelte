<script lang="ts">
  /**
   * The faces beside a room (plans/rewrite/10-faces.md), grouped by what they
   * are doing: waiting for you, here, or somewhere else. Clicking one opens
   * its page (the person's choice); making and hiding one stays in this
   * column's menu, where it was before.
   */
  import { MoreHorizontal, X } from '@lucide/svelte';
  import StatusGlyph, { glyphOf } from '../StatusGlyph.svelte';
  import { presenceText, t } from '../../i18n';
  import { hueOf, initialOf, listed, type Face, type FacePresence } from '../../faces';

  interface Props {
    faces: Face[];
    presence: Record<string, FacePresence>;
    roomId: string;
    /** The rooms' names, so a face elsewhere says where. */
    roomNames?: Record<string, string>;
    onopen: (faceId: string) => void;
    onadd: (name: string) => Promise<unknown>;
    onhide: (faceId: string, hidden: boolean) => Promise<unknown>;
    onclose: () => void;
  }

  let { faces, presence, roomId, roomNames = {}, onopen, onadd, onhide, onclose }: Props = $props();

  let showHidden = $state(false);
  let adding = $state(false);
  let name = $state('');
  let error = $state('');

  const shown = $derived(listed(faces, showHidden));
  const hiddenCount = $derived(faces.filter((face) => face.hiddenAt).length);

  function stateOf(face: Face): 'waiting' | 'other' | 'here' {
    const now = presence[face.id];
    if (now?.state === 'waiting') return 'waiting';
    if (now?.roomId && now.roomId !== roomId) return 'other';
    return 'here';
  }

  /** Whole groups only: an empty heading says nothing. */
  const groups = $derived.by(() => {
    const active = shown.filter((face) => !face.archivedAt);
    const waiting = active.filter((face) => stateOf(face) === 'waiting');
    const other = active.filter((face) => stateOf(face) === 'other');
    const here = active.filter((face) => stateOf(face) === 'here');
    const archived = shown.filter((face) => face.archivedAt);
    return [
      { id: 'waiting', label: t('rooms.members.waitingForYou'), faces: waiting },
      { id: 'here', label: t('rooms.members.idle'), faces: here },
      { id: 'other', label: t('rooms.members.otherRooms'), faces: other },
      { id: 'archived', label: t('common.archived'), faces: archived },
    ].filter((group) => group.faces.length);
  });

  /** The second line: what it is doing, or where. */
  function detail(face: Face): string {
    if (face.archivedAt) return t('common.archived');
    const now = presence[face.id];
    if (!now) return t('common.status.idle');
    if (now.state === 'waiting')
      return now.line
        ? t('rooms.members.waitingLine', { line: now.line })
        : t('common.status.waiting');
    if (now.roomId && now.roomId !== roomId)
      return t('rooms.members.elsewhere', {
        room: roomNames[now.roomId] ?? now.roomId,
        state: presenceText(now),
      });
    return presenceText(now);
  }

  function glyphFor(face: Face) {
    return face.archivedAt ? 'idle' : glyphOf(presence[face.id]?.state ?? 'idle');
  }

  async function add(event: SubmitEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    error = '';
    try {
      await onadd(name.trim());
      name = '';
      adding = false;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : t('rooms.members.couldNotAdd');
    }
  }

  async function hide(face: Face) {
    error = '';
    try {
      await onhide(face.id, !face.hiddenAt);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : t('rooms.members.couldNotChange');
    }
  }
</script>

<aside class="members" aria-label={t('rooms.members.title')}>
  <header>
    <h2 class="section-label">{t('rooms.members.title')}</h2>
    <details class="menu">
      <summary aria-label={t('rooms.members.menu')} title={t('rooms.members.menu')}
        ><MoreHorizontal size={16} /></summary
      >
      <div class="pop">
        <button type="button" class="row" onclick={() => (adding = !adding)}
          >{t('rooms.members.add')}</button
        >
        {#if hiddenCount}
          <button type="button" class="row" onclick={() => (showHidden = !showHidden)}
            >{showHidden
              ? t('rooms.members.leaveOutHidden')
              : t('rooms.members.showHidden', { count: hiddenCount })}</button
          >
        {/if}
      </div>
    </details>
    <button type="button" class="icon" aria-label={t('rooms.members.close')} onclick={onclose}
      ><X size={16} /></button
    >
  </header>
  {#if adding}
    <form class="add" onsubmit={add}>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        aria-label={t('rooms.members.nameLabel')}
        placeholder={t('rooms.members.namePlaceholder')}
        maxlength="40"
        bind:value={name}
        autofocus
      />
    </form>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div class="groups">
    {#each groups as group (group.id)}
      <section aria-label={group.label}>
        <h3 class="section-label">{group.label} — {group.faces.length}</h3>
        <ul>
          {#each group.faces as face (face.id)}
            <li class:archived={!!face.archivedAt} class:elsewhere={group.id === 'other'}>
              <button type="button" class="face" onclick={() => onopen(face.id)}>
                <span
                  class="avatar"
                  style:--hue={hueOf(face.name)}
                  style:background={face.color ?? undefined}
                  aria-hidden="true">{initialOf(face.name, face.avatar)}</span
                >
                <span class="who">
                  <span class="name" style:color={face.color ?? undefined}>{face.name}</span>
                  <span class="detail">
                    <StatusGlyph state={glyphFor(face)} />{detail(face)}
                  </span>
                </span>
              </button>
              {#if face.archivedAt}
                <button type="button" class="small" onclick={() => hide(face)}
                  >{face.hiddenAt ? t('common.show') : t('common.hide')}</button
                >
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  </div>
</aside>

<style>
  .members {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--line);
    background: var(--bg-sidebar);
  }
  header {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 12px 8px 4px 16px;
  }
  h2 {
    flex: 1;
    margin: 0;
  }
  .groups {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 8px 16px;
  }
  section {
    margin-top: 8px;
  }
  h3 {
    margin: 0;
    padding: 4px 8px;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  li.archived {
    opacity: 0.55;
  }
  li.elsewhere .face {
    opacity: 0.72;
  }
  /* 44px rows: a 32px avatar and two lines, as the design draws members. */
  .face {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 44px;
    padding: 4px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-2);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .face:hover {
    background: var(--bg-hover);
  }
  .avatar {
    flex: none;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-weight: 600;
    font-size: 13px;
    color: white;
    background: hsl(var(--hue) 45% 48%);
  }
  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.25;
  }
  .name {
    font-weight: 600;
    color: var(--text-2);
  }
  .detail {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
    font-size: 12px;
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .add {
    padding: 0 12px 8px;
  }
  input {
    width: 100%;
    padding: 6px 8px;
    border: 1px solid var(--line-dark);
    border-radius: var(--radius-sm);
    background: var(--input);
    color: var(--ink);
    font: inherit;
  }
  .menu {
    position: relative;
  }
  summary {
    display: grid;
    place-items: center;
    padding: 4px;
    border-radius: var(--radius-sm);
    color: var(--muted);
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:hover {
    background: var(--bg-hover);
    color: var(--ink);
  }
  .pop {
    position: absolute;
    right: 0;
    z-index: 6;
    width: 200px;
    margin-top: 4px;
    padding: 4px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--bg-layer);
    box-shadow: var(--shadow-pop);
  }
  .row {
    width: 100%;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .row:hover {
    background: var(--bg-hover);
  }
  .icon {
    display: grid;
    place-items: center;
    padding: 4px;
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
  .small {
    padding: 2px 8px;
    border: 0;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .small:hover {
    color: var(--ink);
  }
  .error {
    margin: 4px 16px;
    color: var(--danger);
    font-size: 13px;
  }
</style>

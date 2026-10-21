<script lang="ts">
  /**
   * The faces beside a room (plans/rewrite/10-faces.md): who is here and what
   * each is doing. The host first; an archived face greyed out until someone
   * hides it (decision #18). Clicking one opens its page; "Add" makes one.
   */
  import { Plus, X } from '@lucide/svelte';
  import {
    hueOf,
    initialOf,
    listed,
    presenceLabel,
    roomFace,
    type Face,
    type FacePresence,
  } from '../../faces';

  interface Props {
    faces: Face[];
    presence: Record<string, FacePresence>;
    roomId: string;
    onopen: (faceId: string) => void;
    onadd: (name: string) => Promise<unknown>;
    onhide: (faceId: string, hidden: boolean) => Promise<unknown>;
    onclose: () => void;
  }

  let { faces, presence, roomId, onopen, onadd, onhide, onclose }: Props = $props();

  let showHidden = $state(false);
  let adding = $state(false);
  let name = $state('');
  let error = $state('');

  const own = $derived(roomFace(faces, roomId));
  const shown = $derived(listed(faces, showHidden));
  const hiddenCount = $derived(faces.filter((face) => face.hiddenAt).length);

  async function add(event: SubmitEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    error = '';
    try {
      await onadd(name.trim());
      name = '';
      adding = false;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not add the face.';
    }
  }

  async function hide(face: Face) {
    error = '';
    try {
      await onhide(face.id, !face.hiddenAt);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not change it.';
    }
  }
</script>

<aside class="members" aria-label="Members">
  <header>
    <h2>Members</h2>
    <button
      type="button"
      class="icon"
      aria-label="Add a face"
      title="Add a face"
      onclick={() => (adding = !adding)}><Plus size={16} /></button
    >
    <button type="button" class="icon" aria-label="Close the members" onclick={onclose}
      ><X size={16} /></button
    >
  </header>
  {#if adding}
    <form class="add" onsubmit={add}>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        aria-label="Name of the new face"
        placeholder="Name"
        maxlength="40"
        bind:value={name}
        autofocus
      />
    </form>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <ul>
    {#each shown as face (face.id)}
      {@const state = presence[face.id]}
      <li class:archived={!!face.archivedAt}>
        <button type="button" class="face" onclick={() => onopen(face.id)}>
          <span
            class="avatar"
            style:--hue={hueOf(face.name)}
            style:background={face.color ?? undefined}
            aria-hidden="true">{initialOf(face.name, face.avatar)}</span
          >
          <span class="who">
            <span class="name"
              >{face.name}{#if face.isHost}<span class="tag">host</span
                >{/if}{#if own?.id === face.id}<span class="tag">this room</span>{/if}</span
            >
            <span class="state {face.archivedAt ? 'idle' : (state?.state ?? 'idle')}">
              <span class="dot" aria-hidden="true"></span>{face.archivedAt
                ? 'Archived'
                : presenceLabel(state)}
            </span>
          </span>
        </button>
        {#if face.archivedAt}
          <button type="button" class="small" onclick={() => hide(face)}
            >{face.hiddenAt ? 'Show' : 'Hide'}</button
          >
        {/if}
      </li>
    {/each}
  </ul>
  {#if hiddenCount}
    <button type="button" class="link" onclick={() => (showHidden = !showHidden)}
      >{showHidden ? 'Leave out the hidden ones' : `Show hidden (${hiddenCount})`}</button
    >
  {/if}
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
    padding: 12px 8px 8px 16px;
  }
  h2 {
    flex: 1;
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }
  ul {
    margin: 0;
    padding: 0 8px;
    list-style: none;
    overflow-y: auto;
  }
  li {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  li.archived {
    opacity: 0.55;
  }
  .face {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink);
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
    color: white;
    background: hsl(var(--hue) 45% 48%);
  }
  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
  }
  .tag {
    padding: 0 6px;
    border-radius: 999px;
    background: var(--bg-subtle);
    color: var(--muted);
    font-size: 11px;
    font-weight: 500;
  }
  .state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
    font-size: 12px;
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--success);
  }
  .archived .dot {
    background: var(--muted);
  }
  .thinking .dot,
  .working .dot {
    background: var(--accent);
  }
  .waiting .dot {
    background: var(--warning);
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
  .small,
  .link {
    padding: 2px 8px;
    border: 0;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .small:hover,
  .link:hover {
    color: var(--ink);
  }
  .link {
    margin: 8px 16px;
    text-align: left;
  }
  .error {
    margin: 4px 16px;
    color: var(--danger);
    font-size: 13px;
  }
</style>

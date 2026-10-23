<script lang="ts">
  /**
   * A face's page (plans/rewrite/10-faces.md): its name, bio, voice and role,
   * the rooms, workspaces and sources it looks after, the loops it holds and
   * what it did lately. Changes are saved at once and apply from its next
   * turn. The host's page also holds who pirc is (`SOUL.md`, `CHAT.md`) and
   * the preferences it keeps (plan 03).
   */
  import { ArrowLeft, X } from '@lucide/svelte';
  import { api } from '../../api';
  import {
    facesApi,
    hueOf,
    initialOf,
    type BrainPrompt,
    type Face,
    type FaceActivity,
    type FaceInput,
    type FacePresence,
    type Territory,
  } from '../../faces';
  import { ApiError } from '../../http';
  import { presenceText, t } from '../../i18n';
  import type { MessageKey } from '../../i18n/messages';
  import { describeAnchor } from '../../loops';
  import type { RoomView } from '../../rooms';
  import { sourcesApi, type Source } from '../../sources';
  import { ago } from '../../time';
  import type { Workspace } from '../../types';
  import { statusLabel } from '../../workers';
  import MemorySettings from '../MemorySettings.svelte';

  interface Props {
    face: Face;
    faces: Face[];
    presence?: FacePresence;
    rooms: RoomView[];
    onsave: (input: FaceInput) => Promise<unknown>;
    onback: () => void;
    onclose: () => void;
  }

  let { face, faces, presence, rooms, onsave, onback, onclose }: Props = $props();

  let name = $state('');
  let bio = $state('');
  let tone = $state('');
  let avatar = $state('');
  let color = $state('');
  let roleMd = $state('');
  let territory = $state<Territory>({ rooms: [], workspaces: [], sources: [] });
  let busy = $state(false);
  let error = $state('');
  let saved = $state(false);
  let activity = $state<FaceActivity | undefined>();
  let workspaces = $state<Workspace[]>([]);
  let sources = $state<Source[]>([]);
  let prompts = $state<{ soul: BrainPrompt; chat: BrainPrompt } | undefined>();
  let soul = $state('');
  let chat = $state('');

  /** The form follows the face it shows (another face, or a change from elsewhere). */
  let shownId = '';
  let shownAt = '';
  $effect(() => {
    const stamp = JSON.stringify(face);
    if (face.id === shownId && stamp === shownAt) return;
    const other = face.id !== shownId;
    shownId = face.id;
    shownAt = stamp;
    name = face.name;
    bio = face.bio;
    tone = face.tone;
    avatar = face.avatar ?? '';
    color = face.color ?? '';
    roleMd = face.roleMd;
    territory = $state.snapshot(face.territory);
    if (other) {
      saved = false;
      error = '';
      void loadActivity(face.id);
    }
  });

  $effect(() => {
    if (face.isHost) void loadPrompts();
    else void loadChoices();
  });

  async function loadActivity(id: string) {
    activity = undefined;
    try {
      const loaded = await facesApi.activity(id);
      if (id === face.id) activity = loaded;
    } catch {
      // Shown without it.
    }
  }

  async function loadChoices() {
    if (workspaces.length || sources.length) return;
    const [listedWorkspaces, listedSources] = await Promise.allSettled([
      api.workspaces(),
      sourcesApi.list(),
    ]);
    if (listedWorkspaces.status === 'fulfilled')
      workspaces = listedWorkspaces.value.filter(
        (workspace) => workspace.id.includes(':') && workspace.mode !== 'scratch',
      );
    if (listedSources.status === 'fulfilled') sources = listedSources.value.sources;
  }

  async function loadPrompts() {
    if (prompts) return;
    try {
      prompts = (await facesApi.prompts()).prompts;
      soul = prompts.soul.text;
      chat = prompts.chat.text;
    } catch {
      // The host's page works without them.
    }
  }

  const dirty = $derived(
    name !== face.name ||
      bio !== face.bio ||
      tone !== face.tone ||
      avatar !== (face.avatar ?? '') ||
      color !== (face.color ?? '') ||
      roleMd !== face.roleMd ||
      JSON.stringify(territory) !== JSON.stringify(face.territory),
  );

  /** Rooms another face has: not offered. */
  function ownerOf(roomId: string): Face | undefined {
    return faces.find(
      (other) =>
        other.id !== face.id &&
        !other.isHost &&
        !other.archivedAt &&
        other.territory.rooms.includes(roomId),
    );
  }

  function toggle(key: keyof Territory, id: string, on: boolean) {
    const list = territory[key].filter((item) => item !== id);
    territory = { ...territory, [key]: on ? [...list, id] : list };
  }

  async function act(run: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    error = '';
    saved = false;
    try {
      await run();
      saved = true;
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : t('rooms.error.gateway');
    } finally {
      busy = false;
    }
  }

  function save(event: SubmitEvent) {
    event.preventDefault();
    const input: FaceInput = {};
    if (name !== face.name) input.name = name;
    if (bio !== face.bio) input.bio = bio;
    if (tone !== face.tone) input.tone = tone;
    if (avatar !== (face.avatar ?? '')) input.avatar = avatar.trim() || null;
    if (color !== (face.color ?? '')) input.color = color || null;
    if (roleMd !== face.roleMd) input.roleMd = roleMd;
    if (!face.isHost && JSON.stringify(territory) !== JSON.stringify(face.territory))
      input.territory = territory;
    void act(() => onsave(input));
  }

  function savePrompt(which: 'soul' | 'chat') {
    void act(async () => {
      const { prompt } = await facesApi.savePrompt(which, which === 'soul' ? soul : chat);
      if (prompts) prompts = { ...prompts, [which]: prompt };
    });
  }

  const readOnly = (prompt: BrainPrompt) =>
    prompt.reason === 'nix-store'
      ? t('face.readOnly.nix')
      : prompt.reason === 'symlink'
        ? t('face.readOnly.symlink')
        : t('face.readOnly.notWritable');
  const topicRooms = $derived(rooms.filter((room) => room.kind !== 'general'));
  /** The files a host's page edits, their names, and what each is for. */
  const PROMPTS = [
    ['soul', 'SOUL.md', 'face.prompt.soul'],
    ['chat', 'CHAT.md', 'face.prompt.chat'],
  ] as const satisfies readonly (readonly [string, string, MessageKey])[];
</script>

<aside class="face-page" aria-label={t('face.page', { name: face.name })}>
  <header>
    <button type="button" class="icon" aria-label={t('face.back')} onclick={onback}
      ><ArrowLeft size={16} /></button
    >
    <span
      class="avatar"
      style:--hue={hueOf(face.name)}
      style:background={face.color ?? undefined}
      aria-hidden="true">{initialOf(face.name, face.avatar)}</span
    >
    <div class="title">
      <h2>{face.name}</h2>
      <span class="state"
        >{face.archivedAt ? t('common.archived') : presenceText(presence)}{#if face.isHost}
          · {t('face.theHost')}{/if}</span
      >
    </div>
    <button type="button" class="icon" aria-label={t('common.close')} onclick={onclose}
      ><X size={16} /></button
    >
  </header>

  <div class="body">
    <form onsubmit={save}>
      <label>{t('face.name')}<input bind:value={name} maxlength="40" required /></label>
      <label>{t('face.bio')}<textarea bind:value={bio} rows="2" maxlength="500"></textarea></label>
      <label>{t('face.tone')}<input bind:value={tone} maxlength="300" /></label>
      <div class="pair">
        <label
          >{t('face.avatar')}<input
            bind:value={avatar}
            maxlength="16"
            placeholder={t('face.avatar.placeholder')}
          /></label
        >
        <label
          >{t('face.color')}<span class="color"
            ><input
              type="color"
              bind:value={color}
              aria-label={t('face.color')}
            />{#if color}<button type="button" class="small" onclick={() => (color = '')}
                >{t('face.color.clear')}</button
              >{/if}</span
          ></label
        >
      </div>
      <label
        >{t('face.role')}<textarea
          bind:value={roleMd}
          rows="5"
          placeholder={t('face.role.placeholder')}
        ></textarea></label
      >

      <fieldset>
        <legend>{t('face.territory')}</legend>
        {#if face.isHost}
          <p class="note">{t('face.territory.hostNote')}</p>
        {:else}
          <p class="group">{t('face.territory.rooms')}</p>
          {#each topicRooms as room (room.id)}
            {@const owner = ownerOf(room.id)}
            <label class="check" class:taken={!!owner}>
              <input
                type="checkbox"
                checked={territory.rooms.includes(room.id)}
                disabled={!!owner}
                onchange={(event) => toggle('rooms', room.id, event.currentTarget.checked)}
              />#{room.name}{#if owner}<span class="note">
                  · {t('face.territory.ownedBy', { name: owner.name })}</span
                >{/if}
            </label>
          {:else}
            <p class="note">{t('face.territory.noRooms')}</p>
          {/each}
          <p class="group">{t('face.territory.workspaces')}</p>
          {#each workspaces as workspace (workspace.id)}
            <label class="check">
              <input
                type="checkbox"
                checked={territory.workspaces.includes(workspace.id)}
                onchange={(event) =>
                  toggle('workspaces', workspace.id, event.currentTarget.checked)}
              />{workspace.displayName}<span class="note"> · {workspace.hostId}</span>
            </label>
          {:else}
            <p class="note">{t('face.territory.noWorkspaces')}</p>
          {/each}
          <p class="group">{t('face.territory.sources')}</p>
          {#each sources as source (source.id)}
            <label class="check">
              <input
                type="checkbox"
                checked={territory.sources.includes(source.id)}
                onchange={(event) => toggle('sources', source.id, event.currentTarget.checked)}
              />{source.name}
            </label>
          {:else}
            <p class="note">{t('face.territory.noSources')}</p>
          {/each}
        {/if}
      </fieldset>

      <div class="actions">
        <button type="submit" class="primary" disabled={!dirty || busy}>{t('common.save')}</button>
        {#if !face.isHost}
          <button
            type="button"
            disabled={busy}
            onclick={() => act(() => onsave({ archived: !face.archivedAt }))}
            >{face.archivedAt ? t('rooms.action.unarchive') : t('rooms.action.archive')}</button
          >
        {/if}
        {#if saved && !dirty}<span class="note" role="status">{t('face.saved')}</span>{/if}
      </div>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </form>

    {#if face.isHost && prompts}
      <section>
        <h3>{t('face.prompts')}</h3>
        {#each PROMPTS as [which, file, what] (which)}
          {@const prompt = prompts[which]}
          <label
            >{file} <span class="note">{t(what)}</span>
            {#if which === 'soul'}
              <textarea
                bind:value={soul}
                rows="6"
                maxlength={prompt.maxChars}
                readonly={!prompt.writable}
              ></textarea>
            {:else}
              <textarea
                bind:value={chat}
                rows="6"
                maxlength={prompt.maxChars}
                readonly={!prompt.writable}
              ></textarea>
            {/if}
          </label>
          {#if prompt.writable}
            <button
              type="button"
              disabled={busy || (which === 'soul' ? soul : chat) === prompt.text}
              onclick={() => savePrompt(which)}>{t('face.prompt.save', { file })}</button
            >
          {:else}
            <p class="note">{readOnly(prompt)} ({prompt.path}).</p>
          {/if}
        {/each}
      </section>
    {/if}

    <section>
      <h3>{t('face.loops')}</h3>
      {#if !activity}
        <p class="note">{t('common.loading')}</p>
      {:else if !activity.loops.length}
        <p class="note">{t('face.loops.none')}</p>
      {:else}
        <ul>
          {#each activity.loops as open (open.id)}
            <li>
              {open.what}{#if open.anchor}<span class="note"> · {describeAnchor(open)}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section>
      <h3>{t('face.lately')}</h3>
      {#if activity && !activity.workers.length && !activity.wakes.length}
        <p class="note">{t('face.lately.none')}</p>
      {:else if activity}
        <ul>
          {#each activity.workers as worker (worker.id)}
            <li>
              {worker.title}<span class="note">
                · {statusLabel(worker.status)} · {ago(worker.updatedAt)}</span
              >
            </li>
          {/each}
          {#each activity.wakes as wake (wake.id)}
            <li>
              {t('face.lately.woke', {
                why: wake.trigger.why ?? wake.trigger.name ?? wake.kind,
              })}<span class="note">
                · {wake.outcome ?? t('face.wake.waiting')} · {ago(wake.createdAt)}</span
              >
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    {#if face.isHost}
      <section class="preferences">
        <h3>{t('face.memory')}</h3>
        <MemorySettings />
      </section>
    {/if}
  </div>
</aside>

<style>
  .face-page {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--line);
    background: var(--bg);
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 8px 8px 8px;
    border-bottom: 1px solid var(--line);
  }
  .title {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  h2 {
    margin: 0;
    font-size: 15px;
  }
  h3 {
    margin: 0 0 6px;
    font-size: 13px;
  }
  .state,
  .note,
  .group {
    font-size: 12px;
    color: var(--muted);
  }
  .group {
    margin: 8px 0 2px;
    font-weight: 600;
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
  .body {
    overflow-y: auto;
    padding: 12px 16px 24px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  form,
  section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .color {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  input:not([type='checkbox']):not([type='color']),
  textarea {
    padding: 6px 8px;
    border: 1px solid var(--line-dark);
    border-radius: var(--radius-sm);
    background: var(--input);
    color: var(--ink);
    font: inherit;
  }
  textarea {
    resize: vertical;
  }
  fieldset {
    margin: 0;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }
  legend {
    font-size: 13px;
    font-weight: 600;
  }
  .check {
    flex-direction: row;
    align-items: center;
    gap: 6px;
  }
  .check.taken {
    color: var(--muted);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  button {
    padding: 4px 10px;
    border: 1px solid var(--line-dark);
    border-radius: var(--radius-sm);
    background: var(--bg-layer);
    color: var(--ink);
    font: inherit;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .primary:not(:disabled) {
    border-color: var(--accent);
    background: var(--accent);
    color: white;
  }
  .icon,
  .small {
    padding: 4px;
    border: 0;
    background: none;
    color: var(--muted);
  }
  ul {
    margin: 0;
    padding-left: 18px;
    font-size: 13px;
  }
  .error {
    margin: 0;
    color: var(--danger);
    font-size: 13px;
  }
</style>

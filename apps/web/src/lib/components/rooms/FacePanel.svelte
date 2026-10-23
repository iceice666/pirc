<script lang="ts">
  /**
   * A face's page (design screen 3): a profile, not a form. Its colour as a
   * 104px hero, its 80px avatar and status, its name, badge and bio, the strip
   * that says it waits for you, "Mention in room" and "Edit", then read-only
   * role, territory, open loops and recent cards. Everything editable sits
   * behind Edit (the person's choice); the host's SOUL.md, CHAT.md and
   * remembered preferences stay on its page, below the cards.
   */
  import { AlarmClock, ArrowLeft, Repeat, Wrench, X } from '@lucide/svelte';
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
  import { engineLink } from '../../routes';
  import { sourcesApi, type Source } from '../../sources';
  import { ago } from '../../time';
  import type { Workspace } from '../../types';
  import { statusLabel } from '../../workers';
  import MemorySettings from '../MemorySettings.svelte';
  import StatusGlyph, { glyphOf } from '../StatusGlyph.svelte';

  interface Props {
    face: Face;
    faces: Face[];
    presence?: FacePresence;
    rooms: RoomView[];
    onsave: (input: FaceInput) => Promise<unknown>;
    /** Opens the room with `@name ` in the composer, and sends nothing. */
    onmention: () => void;
    onback: () => void;
    onclose: () => void;
  }

  let { face, faces, presence, rooms, onsave, onmention, onback, onclose }: Props = $props();

  /** The profile, or the form behind Edit. */
  let editing = $state(false);
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
      editing = false;
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

  /** The face's colour: its own, or the hue its avatar would have. */
  const faceColor = $derived(face.color ?? `hsl(${hueOf(face.name)} 45% 48%)`);
  const badge = $derived(face.isHost ? t('common.host') : t('rooms.message.project'));
  const stateWord = $derived(face.archivedAt ? t('common.archived') : presenceText(presence));
  /** The square on the avatar's edge: what the face is doing. */
  const stateGlyph = $derived(face.archivedAt ? 'idle' : glyphOf(presence?.state ?? 'idle'));

  /**
   * A face's waiting line, in words: "Waiting for you · `git push origin
   * fix-lint`". The line is the worker's request or what it works on.
   */
  const waitingLine = $derived(presence?.state === 'waiting' ? presence.line : undefined);

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

  /** Back to the profile, with whatever was typed left behind. */
  function cancel() {
    shownAt = '';
    error = '';
    saved = false;
    editing = false;
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
  const roomNames = $derived(Object.fromEntries(rooms.map((room) => [room.id, room.name])));
  /** The files a host's page edits, their names, and what each is for. */
  const PROMPTS = [
    ['soul', 'SOUL.md', 'face.prompt.soul'],
    ['chat', 'CHAT.md', 'face.prompt.chat'],
  ] as const satisfies readonly (readonly [string, string, MessageKey])[];

  /** The read-only territory card: rooms by name, workspaces by name and node. */
  const roomList = $derived(
    face.territory.rooms.map((id) => `#${roomNames[id] ?? id}`).join(' · '),
  );
  const workspaceList = $derived(
    face.territory.workspaces
      .map((id) => {
        const workspace = workspaces.find((item) => item.id === id);
        return workspace ? `${workspace.displayName} · ${workspace.hostId}` : id;
      })
      .join(' · '),
  );
  const sourceList = $derived(
    face.territory.sources
      .map((id) => sources.find((item) => item.id === id)?.name ?? id)
      .join(' · '),
  );
</script>

{#snippet mark()}
  <span
    class="avatar"
    style:--hue={hueOf(face.name)}
    style:background={faceColor}
    aria-hidden="true">{initialOf(face.name, face.avatar)}</span
  >
{/snippet}

<aside class="face-page" aria-label={t('face.page', { name: face.name })}>
  {#if editing}
    <header>
      <button type="button" class="icon" aria-label={t('common.back')} onclick={cancel}
        ><ArrowLeft size={16} /></button
      >
      {@render mark()}
      <div class="title">
        <h2>{face.name}</h2>
        <span class="state">{t('common.edit')}</span>
      </div>
      <button type="button" class="icon" aria-label={t('common.close')} onclick={onclose}
        ><X size={16} /></button
      >
    </header>

    <div class="body">
      <form onsubmit={save}>
        <label>{t('face.name')}<input bind:value={name} maxlength="40" required /></label>
        <label>{t('face.bio')}<textarea bind:value={bio} rows="2" maxlength="500"></textarea></label
        >
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
          <button type="submit" class="primary" disabled={!dirty || busy}>{t('common.save')}</button
          >
          <button type="button" disabled={busy} onclick={cancel}>{t('common.cancel')}</button>
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
        <section class="prompts">
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

      {#if face.isHost}
        <section class="preferences">
          <h3>{t('face.memory')}</h3>
          <MemorySettings />
        </section>
      {/if}
    </div>
  {:else}
    <div class="hero" style:background={faceColor}>
      <button type="button" class="round" aria-label={t('face.back')} onclick={onback}
        ><ArrowLeft size={18} /></button
      >
      <button type="button" class="round right" aria-label={t('common.close')} onclick={onclose}
        ><X size={18} /></button
      >
      <span
        class="portrait"
        style:--hue={hueOf(face.name)}
        style:background={faceColor}
        aria-hidden="true">{initialOf(face.name, face.avatar)}</span
      >
      <span class="presence" class:waiting={stateGlyph === 'waiting'} aria-hidden="true"
        ><StatusGlyph state={stateGlyph} size={16} /></span
      >
    </div>

    <div class="body profile">
      <div class="who">
        <h2>{face.name}</h2>
        <span
          class="badge"
          style:color={faceColor}
          style:background="color-mix(in srgb, {faceColor} 15%, transparent)">{badge}</span
        >
      </div>
      {#if face.bio}<p class="bio">{face.bio}</p>{:else}<p class="bio note">{stateWord}</p>{/if}

      {#if presence?.state === 'waiting'}
        <div class="waiting" role="status">
          <StatusGlyph state="waiting" size={8} />
          <span class="wait-text"
            >{t('common.status.waiting')}{#if waitingLine}<span aria-hidden="true"> · </span><code
                >{waitingLine}</code
              >{/if}</span
          >
        </div>
      {/if}

      <div class="actions">
        <button type="button" class="mention" onclick={onmention}>{t('face.mention')}</button>
        <button type="button" class="edit" onclick={() => (editing = true)}
          >{t('common.edit')}</button
        >
      </div>

      <section class="card">
        <h3 class="section-label">{t('face.card.role')}</h3>
        {#if face.roleMd}
          <p>{face.roleMd}</p>
        {:else}
          <p class="note">{t('common.none')}</p>
        {/if}
        <button type="button" class="link" onclick={() => (editing = true)}
          >{t('face.role.edit')}</button
        >
      </section>

      <section class="card">
        <h3 class="section-label">{t('face.territory')}</h3>
        {#if face.isHost}
          <p class="note">{t('face.territory.hostNote')}</p>
        {:else}
          <dl class="territory">
            <dt>{t('face.card.rooms')}</dt>
            <dd>{roomList || t('common.none')}</dd>
            <dt>{t('face.card.workspaces')}</dt>
            <dd class="mono">{workspaceList || t('common.none')}</dd>
            <dt>{t('face.card.sources')}</dt>
            <dd>{sourceList || t('common.none')}</dd>
          </dl>
        {/if}
      </section>

      <section class="card">
        <h3 class="section-label">
          {activity ? t('face.loops.count', { count: activity.loops.length }) : t('face.loops')}
        </h3>
        {#if !activity}
          <p class="note">{t('common.loading')}</p>
        {:else if !activity.loops.length}
          <p class="note">{t('face.loops.none')}</p>
        {:else}
          {#each activity.loops as open (open.id)}
            <div class="row">
              {#if open.anchor?.cron}
                <AlarmClock size={16} aria-hidden="true" />
              {:else}
                <Repeat size={16} aria-hidden="true" />
              {/if}
              <div class="what">
                <span>{open.what}</span>
                <span class="note">{describeAnchor(open) || ago(open.createdAt)}</span>
              </div>
            </div>
          {/each}
        {/if}
      </section>

      <section class="card">
        <h3 class="section-label">{t('face.lately')}</h3>
        {#if activity && !activity.workers.length && !activity.wakes.length}
          <p class="note">{t('face.lately.none')}</p>
        {:else if activity}
          {#each activity.workers as worker (worker.id)}
            <div class="row">
              <Wrench size={14} aria-hidden="true" />
              <span class="what-inline"
                >{t('face.recently.worker', { title: worker.title })}<span class="note">
                  · {statusLabel(worker.status)}</span
                ></span
              >
              <time datetime={new Date(worker.updatedAt).toISOString()}
                >{ago(worker.updatedAt)}</time
              >
            </div>
          {/each}
          {#each activity.wakes as wake (wake.id)}
            <div class="row">
              <AlarmClock size={14} aria-hidden="true" />
              <span class="what-inline"
                >{t('face.lately.woke', {
                  why: wake.trigger.why ?? wake.trigger.name ?? wake.kind,
                })}<span class="note"> · {wake.outcome ?? t('face.wake.waiting')}</span></span
              >
              <time datetime={new Date(wake.createdAt).toISOString()}>{ago(wake.createdAt)}</time>
            </div>
          {/each}
          <a class="link" href={engineLink('brain')}>{t('face.lately.seeAll')}</a>
        {:else}
          <p class="note">{t('common.loading')}</p>
        {/if}
      </section>

      {#if face.isHost}
        {#if prompts}
          <section class="card prompts">
            <h3 class="section-label">{t('face.prompts')}</h3>
            {#each PROMPTS as [which, file, what] (which)}
              {@const prompt = prompts[which]}
              <label
                >{file} <span class="note">{t(what)}</span>
                {#if which === 'soul'}
                  <textarea
                    bind:value={soul}
                    rows="5"
                    maxlength={prompt.maxChars}
                    readonly={!prompt.writable}
                  ></textarea>
                {:else}
                  <textarea
                    bind:value={chat}
                    rows="5"
                    maxlength={prompt.maxChars}
                    readonly={!prompt.writable}
                  ></textarea>
                {/if}
              </label>
              {#if prompt.writable}
                <button
                  type="button"
                  class="small"
                  disabled={busy || (which === 'soul' ? soul : chat) === prompt.text}
                  onclick={() => savePrompt(which)}>{t('face.prompt.save', { file })}</button
                >
              {:else}
                <p class="note">{readOnly(prompt)} ({prompt.path}).</p>
              {/if}
            {/each}
          </section>
        {/if}
        <section class="card preferences">
          <h3 class="section-label">{t('face.memory')}</h3>
          <MemorySettings />
        </section>
      {/if}

      {#if error}<p class="error" role="alert">{error}</p>{/if}
      {#if saved}<p class="note" role="status">{t('face.saved')}</p>{/if}
    </div>
  {/if}
</aside>

<style>
  .face-page {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border-left: 1px solid var(--line);
    background: var(--bg-sidebar);
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 8px 8px;
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
    margin: 0;
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
  /* The colour hero: a 104px band, an 80px avatar overlapping it by 40px. */
  .hero {
    position: relative;
    flex: 0 0 104px;
  }
  .round {
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 1;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--scrim);
    color: var(--on-accent);
    cursor: pointer;
  }
  .round.right {
    right: 8px;
    left: auto;
  }
  .portrait {
    position: absolute;
    left: 16px;
    bottom: -40px;
    display: grid;
    place-items: center;
    width: 80px;
    height: 80px;
    border: 6px solid var(--bg-sidebar);
    border-radius: 50%;
    color: white;
    font-size: 26px;
    font-weight: 700;
  }
  /* The status square on the avatar's edge: yellow waits, green works. */
  .presence {
    position: absolute;
    left: 76px;
    bottom: -36px;
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    box-shadow: 0 0 0 5px var(--bg-sidebar);
  }
  .presence.waiting {
    border-radius: 5px;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px 16px 24px;
  }
  /* The profile's body clears the overlapping avatar. */
  .profile {
    padding: 52px 16px 24px;
  }
  .who {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .profile h2 {
    margin: 0;
    overflow: hidden;
    color: var(--ink);
    font-size: 20px;
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    flex: none;
    padding: 0 5px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    line-height: 16px;
    text-transform: uppercase;
  }
  .bio {
    margin: 0;
    color: var(--muted);
    font-size: 14px;
  }
  /* The strip that says it waits for you, with the request in mono. */
  .waiting {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: var(--radius-md);
    background: var(--warning-soft);
    color: var(--warning);
    font-size: 13px;
  }
  .wait-text {
    flex: 1;
    min-width: 0;
  }
  .waiting code {
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .mention {
    flex: 1;
    min-height: 36px;
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--on-accent);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .mention:hover {
    background: var(--accent-hover);
  }
  .edit {
    flex: 0 0 auto;
    min-height: 36px;
    padding: 0 14px;
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--bg-active);
    color: var(--ink);
    font: inherit;
    font-weight: 500;
    cursor: pointer;
  }
  .edit:hover {
    background: var(--bg-hover-strong);
  }
  /* Read-only cards on the inset well. */
  .card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border-radius: var(--radius-md);
    background: var(--code-bg);
  }
  .card p {
    margin: 0;
    color: var(--text-2);
    font-size: 13px;
  }
  .territory {
    display: grid;
    grid-template-columns: 88px minmax(0, 1fr);
    gap: 6px 8px;
    margin: 0;
    font-size: 13px;
  }
  .territory dt {
    color: var(--faint);
  }
  .territory dd {
    margin: 0;
    color: var(--text-2);
    overflow-wrap: anywhere;
  }
  .territory dd.mono {
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .row {
    display: flex;
    gap: 10px;
    font-size: 13px;
    color: var(--muted);
  }
  .row :global(svg) {
    flex: none;
    margin-top: 2px;
  }
  .what {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .what > span:first-child {
    color: var(--ink);
  }
  .what-inline {
    flex: 1;
    min-width: 0;
    color: var(--ink);
  }
  .row time {
    flex: none;
    color: var(--faint);
    font-size: 12px;
  }
  .link {
    align-self: flex-start;
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent-ink);
    font: inherit;
    font-size: 13px;
    text-decoration: none;
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  form,
  .prompts,
  .preferences {
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
  .card .small {
    align-self: flex-start;
    border: 1px solid var(--line-dark);
    color: var(--ink);
  }
  .error {
    margin: 0;
    color: var(--danger);
    font-size: 13px;
  }
</style>

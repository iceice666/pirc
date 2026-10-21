<script lang="ts">
  /**
   * Sources (plans/rewrite/09-sources.md), next to the model backends
   * (decision #6): add a mailbox, a calendar, Moodle or a workspace; try,
   * read now, pause, remove. Credentials are write-only: no answer holds one.
   */
  import { onMount } from 'svelte';
  import { ApiError } from '../http';
  import {
    KIND_LABELS,
    describeSource,
    sourceStatus,
    sourcesApi,
    type Source,
    type SourceInput,
    type SourceItem,
    type SourceKind,
  } from '../sources';
  import { ago } from '../time';

  interface Props {
    disabled?: boolean;
  }

  let { disabled = false }: Props = $props();

  const GMAIL = 'imap.gmail.com';

  let sources: Source[] = $state([]);
  let loading = $state(true);
  let busy = $state('');
  let error = $state('');
  let notice = $state('');
  let alive = true;
  /** The add form, or a source signing in again; a fresh object per opening. */
  let form: { editing?: Source } | undefined = $state();
  let confirmRemove = $state('');
  let items: Record<string, SourceItem[]> = $state({});

  // The form's fields.
  let kind: SourceKind = $state('email');
  let name = $state('');
  let provider: 'gmail' | 'other' = $state('gmail');
  let username = $state('');
  let password = $state('');
  let host = $state('');
  let port = $state('993');
  let mailbox = $state('INBOX');
  let calendarMode: 'ics' | 'caldav' = $state('ics');
  let address = $state('');
  let moodleLogin: 'password' | 'app' = $state('password');
  let launchUrl = $state('');
  let pasted = $state('');
  let workspace = $state('');

  const message = (cause: unknown) =>
    cause instanceof ApiError ? cause.message : 'Unable to reach the gateway. Try again.';

  async function load() {
    try {
      const list = await sourcesApi.list();
      if (!alive) return;
      sources = list.sources;
      error = '';
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) loading = false;
    }
  }

  onMount(() => {
    if (disabled) loading = false;
    else void load();
    return () => {
      alive = false;
    };
  });

  async function act(id: string, action: () => Promise<string | void>) {
    if (busy) return;
    busy = id;
    error = '';
    notice = '';
    try {
      const said = await action();
      if (said && alive) notice = said;
      await load();
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      busy = '';
    }
  }

  function open(editing?: Source) {
    form = { editing };
    kind = editing?.kind ?? 'email';
    name = editing?.name ?? '';
    const config = editing?.config ?? {};
    const text = (key: string) => (typeof config[key] === 'string' ? (config[key] as string) : '');
    provider = !editing || text('host') === GMAIL ? 'gmail' : 'other';
    username = text('username');
    host = text('host') === GMAIL ? '' : text('host');
    port = String(config.port ?? 993);
    mailbox = text('mailbox') || 'INBOX';
    calendarMode = text('mode') === 'caldav' ? 'caldav' : 'ics';
    address = kind === 'moodle' || calendarMode === 'caldav' ? text('url') : '';
    password = '';
    moodleLogin = 'password';
    launchUrl = '';
    pasted = '';
    workspace = text('workspace');
  }

  function input(): SourceInput {
    switch (kind) {
      case 'email':
        return {
          config: {
            host: provider === 'gmail' ? GMAIL : host.trim(),
            port: Number(port) || 993,
            username: username.trim(),
            mailbox: mailbox.trim() || 'INBOX',
          },
          secret: { password },
        };
      case 'calendar':
        return calendarMode === 'ics'
          ? { config: { mode: 'ics' }, secret: { url: address.trim() } }
          : {
              config: { mode: 'caldav', url: address.trim(), username: username.trim() },
              secret: { password },
            };
      case 'moodle':
        return {
          config: { url: address.trim() },
          secret:
            moodleLogin === 'app'
              ? { launch: pasted.trim() }
              : { username: username.trim(), password },
        };
      case 'workspace':
        return { config: { workspace: workspace.trim() } };
    }
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const editing = form?.editing;
    await act(editing?.id ?? 'new', async () => {
      const said = editing
        ? (await sourcesApi.update(editing.id, { name: name.trim() || undefined, ...input() })).test
        : (await sourcesApi.create({ kind, name: name.trim(), ...input() })).test;
      form = undefined;
      password = '';
      return said ? `${editing ? 'Saved' : 'Added'}: ${said}` : 'Saved.';
    });
  }

  async function startAppLogin() {
    await act('launch', async () => {
      launchUrl = (await sourcesApi.moodleLaunch(address.trim())).launchUrl;
    });
  }

  async function poll(source: Source) {
    await act(source.id, async () => {
      const result = await sourcesApi.poll(source.id);
      if (result.error) throw new ApiError(result.error.message, 502);
      if (result.baseline) return `${source.name}: read for the first time.`;
      const count = result.changed.length;
      return `${source.name}: ${count ? `${count} new or changed` : 'nothing new'}${result.wake ? ', and pirc woke up for it' : ''}.`;
    });
    if (items[source.id]) await showItems(source);
  }

  async function remove(source: Source) {
    if (confirmRemove !== source.id) {
      confirmRemove = source.id;
      return;
    }
    confirmRemove = '';
    await act(source.id, async () => {
      await sourcesApi.remove(source.id);
      return `Removed ${source.name}.`;
    });
  }

  async function showItems(source: Source) {
    try {
      const { items: found } = await sourcesApi.items(source.id);
      if (alive) items = { ...items, [source.id]: found };
    } catch (cause) {
      if (alive) error = message(cause);
    }
  }
</script>

<section class="settings-section source-settings" aria-labelledby="sources-title">
  <h3 id="sources-title">Sources</h3>
  <p>
    What pirc can read beyond the rooms: a mailbox, a calendar, Moodle, a workspace's commits. All
    read-only. Credentials stay on the gateway and are never shown again. pirc wakes for something
    new only when a room follows the source, or when it touches an open loop.
  </p>

  {#if disabled}
    <p role="status">Sources are unavailable in demo mode.</p>
  {:else if loading}
    <p role="status">Loading sources…</p>
  {:else}
    {#if error}<p class="source-error" role="alert">{error}</p>{/if}
    {#if notice}<p class="source-notice" role="status">{notice}</p>{/if}

    {#each sources as source (source.id)}
      {@const status = sourceStatus(source)}
      <div class="source-card">
        <strong>{source.name}</strong>
        <small>{KIND_LABELS[source.kind]} · {describeSource(source)}</small>
        <small class="tone-{status.tone}"
          >{status.text}{#if source.lastPolledAt && !source.pausedAt}
            · last read {ago(source.lastPolledAt)}{/if}</small
        >
        {#if source.rooms.length}<small
            >Followed in {source.rooms.map((room) => `#${room}`).join(', ')}</small
          >{/if}
        <div class="source-actions">
          {#if !source.pausedAt}<button
              class="button ghost small"
              type="button"
              disabled={!!busy}
              onclick={() => poll(source)}>Read now</button
            >{/if}
          <button
            class="button ghost small"
            type="button"
            disabled={!!busy}
            onclick={() =>
              act(
                source.id,
                async () => `${source.name}: ${(await sourcesApi.test(source.id)).test}`,
              )}>Test</button
          >
          <button
            class="button ghost small"
            type="button"
            disabled={!!busy}
            onclick={() =>
              act(source.id, async () => {
                await (source.pausedAt
                  ? sourcesApi.resume(source.id)
                  : sourcesApi.pause(source.id));
              })}>{source.pausedAt ? 'Resume' : 'Pause'}</button
          >
          {#if source.kind !== 'workspace'}<button
              class="button ghost small"
              type="button"
              disabled={!!busy || !!form}
              onclick={() => open(source)}>Sign in again</button
            >{/if}
          <button
            class="button ghost small"
            type="button"
            disabled={!!busy}
            onclick={() => remove(source)}
            >{confirmRemove === source.id ? `Remove ${source.name}?` : 'Remove'}</button
          >
        </div>
        <details
          ontoggle={(event) => {
            if ((event.currentTarget as HTMLDetailsElement).open) void showItems(source);
          }}
        >
          <summary>What it saw</summary>
          {#if items[source.id]?.length}
            <ul>
              {#each items[source.id] ?? [] as item (item.id)}
                <li>{item.summary}</li>
              {/each}
            </ul>
          {:else if items[source.id]}
            <p>Nothing yet.</p>
          {/if}
        </details>
      </div>
    {/each}

    {#if form}
      <form class="source-form" onsubmit={save}>
        <h4>{form.editing ? `Sign in to ${form.editing.name} again` : 'Add a source'}</h4>
        {#if !form.editing}
          <label
            ><span>Kind</span><select bind:value={kind}
              >{#each Object.entries(KIND_LABELS) as [value, label] (value)}<option {value}
                  >{label}</option
                >{/each}</select
            ></label
          >
        {/if}
        <label
          ><span>Name</span><input
            bind:value={name}
            maxlength="100"
            placeholder={kind === 'email' ? 'Gmail (school)' : KIND_LABELS[kind]}
            required={!form.editing}
          /></label
        >

        {#if kind === 'email'}
          <label
            ><span>Mail server</span><select bind:value={provider}
              ><option value="gmail">Gmail</option><option value="other">Other (IMAP)</option
              ></select
            ></label
          >
          <label
            ><span>Email address</span><input
              bind:value={username}
              autocomplete="off"
              required
            /></label
          >
          <label
            ><span>{provider === 'gmail' ? 'App password' : 'Password'}</span><input
              type="password"
              bind:value={password}
              autocomplete="new-password"
              required
            /></label
          >
          {#if provider === 'gmail'}
            <p class="hint">
              Gmail needs an app password (with 2-Step Verification on): create one at
              <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer"
                >myaccount.google.com/apppasswords</a
              >. pirc only reads; nothing is marked read.
            </p>
          {:else}
            <label><span>IMAP host</span><input bind:value={host} required /></label>
            <label><span>Port (TLS)</span><input bind:value={port} inputmode="numeric" /></label>
            <label><span>Mailbox</span><input bind:value={mailbox} /></label>
          {/if}
        {:else if kind === 'calendar'}
          <label
            ><span>Calendar</span><select bind:value={calendarMode}
              ><option value="ics">An ICS address</option><option value="caldav">CalDAV</option
              ></select
            ></label
          >
          {#if calendarMode === 'ics'}
            <label
              ><span>ICS address</span><input
                type="password"
                bind:value={address}
                autocomplete="off"
                placeholder="https://… .ics"
                required
              /></label
            >
            <p class="hint">
              Google Calendar: Settings → the calendar → "Secret address in iCal format". Moodle:
              Calendar → Export calendar → the URL. The address is a secret and is kept as one.
            </p>
          {:else}
            <label
              ><span>Calendar address</span><input
                bind:value={address}
                placeholder="https://…/calendars/me/personal/"
                required
              /></label
            >
            <label><span>User name</span><input bind:value={username} required /></label>
            <label
              ><span>Password</span><input
                type="password"
                bind:value={password}
                autocomplete="new-password"
                required
              /></label
            >
          {/if}
        {:else if kind === 'moodle'}
          <label
            ><span>Moodle address</span><input
              bind:value={address}
              placeholder="https://moodle.school.edu"
              required
            /></label
          >
          <label
            ><span>Sign in with</span><select bind:value={moodleLogin}
              ><option value="password">User name and password</option><option value="app"
                >My school signs in on another page (SSO)</option
              ></select
            ></label
          >
          {#if moodleLogin === 'password'}
            <label><span>User name</span><input bind:value={username} required /></label>
            <label
              ><span>Password</span><input
                type="password"
                bind:value={password}
                autocomplete="new-password"
                required
              /></label
            >
            <p class="hint">
              As the Moodle app signs in. Only the token Moodle gives back is kept, never the
              password.
            </p>
          {:else}
            <button
              class="button ghost small"
              type="button"
              disabled={!!busy || !address.trim()}
              onclick={startAppLogin}>Start the app login</button
            >
            {#if launchUrl}
              <p class="hint">
                <a href={launchUrl} target="_blank" rel="noreferrer">Open the Moodle login</a>
                and sign in. It ends at an address starting with <code>moodlemobile://token=</code>,
                which the browser cannot open: copy it (from the address bar, or the developer
                tools' Network tab) and paste it here within 30 minutes.
              </p>
              <label
                ><span>Where it ended</span><input
                  bind:value={pasted}
                  autocomplete="off"
                  placeholder="moodlemobile://token=…"
                  required
                /></label
              >
            {/if}
          {/if}
        {:else}
          <label
            ><span>Workspace id</span><input
              bind:value={workspace}
              placeholder="node:workspace"
              required
            /></label
          >
          <p class="hint">Its node is asked for new commits once a day, while it is online.</p>
        {/if}

        <div class="source-actions">
          <button class="button" type="submit" disabled={!!busy}
            >{busy === 'new' || busy === form.editing?.id ? 'Trying it…' : 'Try and save'}</button
          >
          <button class="button ghost" type="button" onclick={() => (form = undefined)}
            >Cancel</button
          >
        </div>
      </form>
    {:else}
      <button class="button ghost" type="button" disabled={!!busy} onclick={() => open()}
        >Add source</button
      >
    {/if}
  {/if}
</section>

<style>
  h4 {
    margin: 0 0 10px;
    font-size: 14px;
  }
  .source-card,
  .source-form {
    margin: 12px 0;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }
  .source-form label {
    display: grid;
    gap: 4px;
    margin: 8px 0;
  }
  strong {
    font-size: 13px;
  }
  small {
    display: block;
    margin-top: 4px;
    color: var(--muted);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .tone-ok {
    color: var(--success, var(--muted));
  }
  .tone-error,
  .source-error {
    color: var(--danger, #d54444);
  }
  .source-notice {
    color: var(--muted);
  }
  .hint {
    color: var(--muted);
    font-size: 12px;
  }
  .source-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 10px;
  }
  details {
    margin-top: 8px;
    font-size: 13px;
  }
  details summary {
    cursor: pointer;
    color: var(--muted);
  }
  details ul {
    max-height: 200px;
    overflow-y: auto;
    padding-left: 20px;
  }
</style>

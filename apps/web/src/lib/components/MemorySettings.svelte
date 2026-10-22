<script lang="ts">
  /**
   * The brain's memory (docs/architecture/memory.md): your preferences, which
   * pirc always has in mind, and the facts it keeps and finds when they matter. Review
   * where each came from, take preferences out or back, and forget for good.
   */
  import { onMount } from 'svelte';
  import { ApiError } from '../http';
  import {
    describeOrigin,
    describeOrigins,
    describeVersion,
    memoryApi,
    type MemoryRecord,
    type MemoryVersion,
    type Preference,
    type PreferencesView,
    type RecordScope,
  } from '../memory';
  import { ago } from '../time';
  import { watch } from '../watch.svelte';

  interface Props {
    disabled?: boolean;
    /** Bumped when the gateway says memory changed: reload. */
    revision?: number;
  }

  let { disabled = false, revision = 0 }: Props = $props();

  let view: PreferencesView | undefined = $state();
  let records: MemoryRecord[] = $state([]);
  let scope: RecordScope = $state('person');
  let query = $state('');
  let loading = $state(true);
  /** Key of the action in flight; one at a time. */
  let busy = $state('');
  let error = $state('');
  /** Preference or fact whose Forget awaits a second click. */
  let confirming: string | undefined = $state();
  let historyFor: string | undefined = $state();
  let versions: MemoryVersion[] = $state([]);
  let alive = true;

  const number = (value: number) => value.toLocaleString();
  const message = (cause: unknown) =>
    cause instanceof ApiError ? cause.message : 'Unable to reach the gateway. Try again.';

  function show(next: PreferencesView) {
    view = next;
    confirming = undefined;
    const listed = [...next.preferences, ...next.removed];
    if (historyFor && !listed.some((preference) => preference.id === historyFor))
      historyFor = undefined;
    else if (historyFor) void loadHistory(historyFor);
  }

  async function loadRecords() {
    try {
      const listed = await memoryApi.records(scope, query);
      if (alive) records = listed;
    } catch (cause) {
      if (alive) error = message(cause);
    }
  }

  async function load() {
    try {
      const [next] = await Promise.all([memoryApi.view(), loadRecords()]);
      if (alive) show(next);
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) loading = false;
    }
  }

  async function loadHistory(id: string) {
    try {
      const listed = await memoryApi.history(id);
      if (alive && historyFor === id) versions = listed;
    } catch (cause) {
      if (alive) error = message(cause);
    }
  }

  async function act(key: string, run: () => Promise<PreferencesView>) {
    if (busy) return;
    busy = key;
    error = '';
    try {
      const next = await run();
      if (alive) show(next);
    } catch (cause) {
      if (alive) {
        error = message(cause);
        // Changed elsewhere (a room, another tab): show the current state.
        if (cause instanceof ApiError && cause.status === 409) void load();
      }
    } finally {
      busy = '';
    }
  }

  async function forgetRecord(record: MemoryRecord) {
    if (busy) return;
    busy = record.id;
    error = '';
    try {
      await memoryApi.forgetRecord(record.id);
      confirming = undefined;
      await loadRecords();
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      busy = '';
    }
  }

  function toggleHistory(preference: Preference) {
    if (historyFor === preference.id) {
      historyFor = undefined;
      return;
    }
    historyFor = preference.id;
    versions = [];
    void loadHistory(preference.id);
  }

  function search(event: SubmitEvent) {
    event.preventDefault();
    void loadRecords();
  }

  onMount(() => {
    if (disabled) loading = false;
    else void load();
    return () => {
      alive = false;
    };
  });
  // What pirc remembers in a room arrives while this is open.
  watch(
    () => revision,
    () => {
      if (!disabled) void load();
    },
  );
</script>

<section class="settings-section" aria-labelledby="memory-title">
  <h3 id="memory-title">Memory</h3>
  <p>
    What pirc remembers, in every room. <strong>Preferences</strong> are always on its mind; it
    saves one only when you say so. <strong>Facts</strong> it keeps on its own and brings up when they
    matter; each says where it came from, and the room shows a line when one is kept. Coding sessions
    on the nodes have none of this: repositories keep their own workspace notes.
  </p>

  {#if disabled}
    <p role="status">Memory is unavailable in demo mode.</p>
  {:else if loading}
    <p role="status">Loading memory…</p>
  {:else}
    {#if error}<p class="memory-error" role="alert">{error}</p>{/if}
    {#if view}
      <h4>Preferences</h4>
      <p class="memory-usage">
        {number(view.usage.used)}/{number(view.usage.max)} characters
      </p>
      {#if view.preferences.length}
        {@render preferences(view.preferences, 'Preferences')}
      {:else}
        <p>None yet. Tell pirc how you want things, or say yes when it offers to remember.</p>
      {/if}

      {#if view.removed.length}
        <details class="memory-removed">
          <summary>Removed · {view.removed.length}</summary>
          {@render preferences(view.removed, 'Removed')}
        </details>
      {/if}
    {/if}

    <h4>Facts</h4>
    <form class="memory-search" role="search" onsubmit={search}>
      <input
        type="search"
        aria-label="Search facts"
        placeholder="Search facts"
        bind:value={query}
      />
      <select
        aria-label="Which facts"
        value={scope}
        onchange={(event) => {
          scope = event.currentTarget.value as RecordScope;
          void loadRecords();
        }}
      >
        <option value="person">Yours</option>
        <option value="repo">Repositories</option>
        <option value="all">Both</option>
      </select>
      <button class="button ghost small" type="submit">Search</button>
    </form>
    {#if records.length}
      <ul class="memory-list" aria-label="Facts">
        {#each records as record (record.kind + record.id)}
          <li>
            <div class="memory-row">
              <div class="memory-text">
                <span>{record.content}</span>
                <small
                  >{record.kind === 'fact'
                    ? describeOrigin(record.origin ?? '')
                    : record.kind === 'delegation'
                      ? `Delegated to ${record.workspace}`
                      : `Workspace note · ${record.workspace}`}{#if record.git}
                    · {record.git}{/if} · {record.date}{#if record.status !== 'active'}
                    · {record.status}{/if}</small
                >
              </div>
              {#if record.kind === 'fact'}
                <div class="memory-actions">
                  {#if confirming === record.id}
                    <button
                      class="button ghost small forget"
                      type="button"
                      disabled={!!busy}
                      onclick={() => forgetRecord(record)}>Forget for good</button
                    >
                    <button
                      class="button ghost small"
                      type="button"
                      onclick={() => (confirming = undefined)}>Cancel</button
                    >
                  {:else}
                    <button
                      class="button ghost small"
                      type="button"
                      disabled={!!busy}
                      onclick={() => (confirming = record.id)}>Forget</button
                    >
                  {/if}
                </div>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <p>{query.trim() ? 'Nothing found.' : 'No facts yet.'}</p>
    {/if}

    <p class="memory-fine-print">
      Forget erases a preference or fact with all its versions, takes it out of search and of the
      room's line, and keeps the same text from being saved again; rewordings are not caught. A
      repository's notes are forgotten on its node.
    </p>
  {/if}
</section>

{#snippet room(roomId: string | null)}
  {#if roomId && view?.rooms[roomId]}#{view.rooms[roomId]}{:else}a room{/if}
{/snippet}

{#snippet preferences(list: Preference[], label: string)}
  <ul class="memory-list" aria-label={label}>
    {#each list as preference (preference.id)}
      <li>
        <div class="memory-row">
          <div class="memory-text">
            <span>{preference.content}</span>
            <small
              >{describeOrigins(preference.origins)}{#if preference.sources.quote}
                — you said “{preference.sources.quote}”{/if} · in {@render room(
                preference.createdInRoom,
              )} · {ago(preference.updatedAt)}</small
            >
          </div>
          <div class="memory-actions">
            {#if preference.status === 'removed'}
              <button
                class="button ghost small"
                type="button"
                disabled={!!busy}
                onclick={() => act(preference.id, () => memoryApi.restore(preference.id))}
                >Restore</button
              >
            {:else}
              <button
                class="button ghost small"
                type="button"
                aria-expanded={historyFor === preference.id}
                onclick={() => toggleHistory(preference)}>History</button
              >
              <button
                class="button ghost small"
                type="button"
                disabled={!!busy}
                onclick={() => act(preference.id, () => memoryApi.remove(preference.id))}
                >Remove</button
              >
            {/if}
            {#if confirming === preference.id}
              <button
                class="button ghost small forget"
                type="button"
                disabled={!!busy}
                onclick={() => act(preference.id, () => memoryApi.forget(preference.id))}
                >Forget for good</button
              >
              <button
                class="button ghost small"
                type="button"
                onclick={() => (confirming = undefined)}>Cancel</button
              >
            {:else}
              <button
                class="button ghost small"
                type="button"
                disabled={!!busy}
                onclick={() => (confirming = preference.id)}>Forget</button
              >
            {/if}
          </div>
        </div>
        {#if historyFor === preference.id}
          <ol class="memory-history" aria-label="History">
            {#each versions as version (version.revision)}
              <li>
                <small>{describeVersion(version)} · {ago(version.at)}</small>
                {#if version.content}<span>{version.content}</span>{/if}
                {#if version.content && version.content !== preference.content}
                  <button
                    class="button ghost small"
                    type="button"
                    disabled={!!busy}
                    onclick={() =>
                      act(preference.id, () => memoryApi.restore(preference.id, version.revision))}
                    >Restore this</button
                  >
                {/if}
              </li>
            {/each}
          </ol>
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<style>
  h4 {
    margin: 16px 0 6px;
    color: var(--ink);
    font-size: 13px;
    font-weight: 600;
  }
  .memory-error {
    color: var(--danger);
  }
  .memory-usage,
  .memory-fine-print {
    color: var(--muted);
    font-size: 12px;
  }
  .memory-search {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
  }
  .memory-search input {
    flex: 1 1 200px;
    min-width: 0;
  }
  .memory-list {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .memory-list > li {
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-subtle);
  }
  .memory-row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px 12px;
  }
  .memory-text {
    display: flex;
    flex: 1 1 240px;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  small {
    color: var(--muted);
    font-size: 12px;
  }
  .memory-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .forget {
    color: var(--danger);
  }
  .memory-history {
    display: grid;
    gap: 6px;
    margin: 8px 0 0;
    padding: 8px 0 0 12px;
    border-top: 1px solid var(--line);
    list-style: none;
    font-size: 13px;
  }
  .memory-history li {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }
  .memory-removed {
    margin-top: 12px;
  }
  .memory-removed summary {
    margin-bottom: 6px;
    color: var(--text-2);
    font-size: 13px;
    cursor: pointer;
  }
</style>

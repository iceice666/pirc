<script lang="ts">
  /**
   * The assistant's memory (docs/history/assistant.md): approve or reject what it
   * proposes to remember about you, review its notes and their history,
   * restore earlier versions, and forget entries for good.
   */
  import { onMount } from 'svelte';
  import { app } from '../app.svelte';
  import { ApiError } from '../http';
  import {
    describeOrigins,
    describeVersion,
    memoryApi,
    type MemoryEntry,
    type MemoryProposal,
    type MemoryVersion,
    type MemoryView,
  } from '../memory';
  import { ago } from '../time';
  import { watch } from '../watch.svelte';

  interface Props {
    disabled?: boolean;
    /** Open the chat an entry or proposal came from. */
    onopenchat?: (sessionId: string) => void;
  }

  let { disabled = false, onopenchat }: Props = $props();

  let view: MemoryView | undefined = $state();
  let loading = $state(true);
  /** Key of the action in flight; one at a time. */
  let busy = $state('');
  let error = $state('');
  /** Entry whose Forget awaits a second click. */
  let confirming: string | undefined = $state();
  let historyFor: string | undefined = $state();
  let versions: MemoryVersion[] = $state([]);
  let alive = true;

  const ACTION: Record<MemoryProposal['action'], string> = {
    add: 'Remember',
    replace: 'Change',
    remove: 'Forget',
  };
  const number = (value: number) => value.toLocaleString();
  const message = (cause: unknown) =>
    cause instanceof ApiError ? cause.message : 'Unable to reach the gateway. Try again.';

  function show(next: MemoryView) {
    view = next;
    app.memoryPending = next.proposals.length;
    confirming = undefined;
    const listed = [...next.user, ...next.notes, ...next.removed];
    if (historyFor && !listed.some((entry) => entry.id === historyFor)) historyFor = undefined;
    else if (historyFor) void loadHistory(historyFor);
  }

  async function load() {
    try {
      const next = await memoryApi.view();
      if (alive) show(next);
    } catch (cause) {
      if (alive) error = message(cause);
    } finally {
      if (alive) loading = false;
    }
  }

  async function loadHistory(entryId: string) {
    try {
      const listed = await memoryApi.history(entryId);
      if (alive && historyFor === entryId) versions = listed;
    } catch (cause) {
      if (alive) error = message(cause);
    }
  }

  async function act(key: string, run: () => Promise<MemoryView>) {
    if (busy) return;
    busy = key;
    error = '';
    try {
      const next = await run();
      if (alive) show(next);
    } catch (cause) {
      if (alive) {
        error = message(cause);
        // Someone else (another chat, another tab) changed it: show the current state.
        if (cause instanceof ApiError && cause.status === 409) void load();
      }
    } finally {
      busy = '';
    }
  }

  function toggleHistory(entry: MemoryEntry) {
    if (historyFor === entry.id) {
      historyFor = undefined;
      return;
    }
    historyFor = entry.id;
    versions = [];
    void loadHistory(entry.id);
  }

  onMount(() => {
    if (disabled) loading = false;
    else void load();
    return () => {
      alive = false;
    };
  });
  // Changes from chats (a new proposal, a note) arrive while this is open.
  watch(
    () => app.memoryRevision,
    () => {
      if (!disabled) void load();
    },
  );
</script>

<section class="settings-section" aria-labelledby="memory-title">
  <h3 id="memory-title">Memory</h3>
  <p>
    What your assistant remembers across chats. <strong>USER</strong> is what you told it about
    yourself and changes only when you approve. <strong>MEMORY</strong> holds the assistant's own notes.
    New chats start with both; open chats keep what they started with.
  </p>

  {#if disabled}
    <p role="status">Memory is unavailable in demo mode.</p>
  {:else if loading}
    <p role="status">Loading memory…</p>
  {:else}
    {#if error}<p class="memory-error" role="alert">{error}</p>{/if}
    {#if view}
      <p class="memory-usage">
        USER {number(view.usage.user.used)}/{number(view.usage.user.max)} characters · MEMORY {number(
          view.usage.note.used,
        )}/{number(view.usage.note.max)} characters
      </p>

      {#if view.proposals.length}
        <h4>Waiting for you</h4>
        <ul class="memory-list" aria-label="Waiting for you">
          {#each view.proposals as proposal (proposal.id)}
            <li class="proposal">
              <div class="memory-row">
                <div class="memory-text">
                  <span
                    ><strong>{ACTION[proposal.action]}:</strong>
                    {proposal.content ?? proposal.target?.content ?? ''}</span
                  >
                  {#if proposal.action === 'replace' && proposal.target}
                    <small>Now: {proposal.target.content}</small>
                  {/if}
                  <small
                    >You said “{proposal.quote}” · {@render chat(proposal.sessionId)} · {ago(
                      proposal.createdAt,
                    )}</small
                  >
                </div>
                <div class="memory-actions">
                  <button
                    class="button dark small"
                    type="button"
                    disabled={!!busy}
                    onclick={() =>
                      act(proposal.id, () =>
                        memoryApi.approve(proposal.id, proposal.target?.revision),
                      )}>Approve</button
                  >
                  <button
                    class="button ghost small"
                    type="button"
                    disabled={!!busy}
                    onclick={() => act(proposal.id, () => memoryApi.reject(proposal.id))}
                    >Reject</button
                  >
                </div>
              </div>
            </li>
          {/each}
        </ul>
      {/if}

      <h4>About you · USER</h4>
      {#if view.user.length}
        {@render entries(view.user, 'About you')}
      {:else}
        <p>Nothing yet. When you tell the assistant about yourself, it asks you here first.</p>
      {/if}

      <h4>The assistant's notes · MEMORY</h4>
      {#if view.notes.length}
        {@render entries(view.notes, "The assistant's notes")}
      {:else}
        <p>No notes yet.</p>
      {/if}

      {#if view.removed.length}
        <details class="memory-removed">
          <summary>Removed · {view.removed.length}</summary>
          {@render entries(view.removed, 'Removed')}
        </details>
      {/if}

      <p class="memory-fine-print">
        Forget erases an entry with all its versions and keeps the same text from being saved again;
        rewordings are not caught. The chats it came from stay on the chat node, and repositories
        keep their own workspace memory.
      </p>
    {/if}
  {/if}
</section>

{#snippet chat(sessionId: string | undefined)}
  {#if sessionId && view?.sessions[sessionId]}
    <button class="chat-link" type="button" onclick={() => onopenchat?.(sessionId)}
      >{view.sessions[sessionId]}</button
    >
  {:else}
    a chat that is gone
  {/if}
{/snippet}

{#snippet entries(list: MemoryEntry[], label: string)}
  <ul class="memory-list" aria-label={label}>
    {#each list as entry (entry.id)}
      <li>
        <div class="memory-row">
          <div class="memory-text">
            <span>{entry.content}</span>
            <small
              >{describeOrigins(entry.origins)}{#if entry.sources.quote}
                — you said “{entry.sources.quote}”{/if} · {@render chat(entry.sources.sessionId)} · {ago(
                entry.updatedAt,
              )}</small
            >
          </div>
          <div class="memory-actions">
            {#if entry.status === 'removed'}
              <button
                class="button ghost small"
                type="button"
                disabled={!!busy}
                onclick={() => act(entry.id, () => memoryApi.restore(entry.id))}>Restore</button
              >
            {:else}
              <button
                class="button ghost small"
                type="button"
                aria-expanded={historyFor === entry.id}
                onclick={() => toggleHistory(entry)}>History</button
              >
            {/if}
            {#if confirming === entry.id}
              <button
                class="button ghost small forget"
                type="button"
                disabled={!!busy}
                onclick={() => act(entry.id, () => memoryApi.forget(entry.id))}
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
                onclick={() => (confirming = entry.id)}>Forget</button
              >
            {/if}
          </div>
        </div>
        {#if historyFor === entry.id}
          <ol class="memory-history" aria-label="History">
            {#each versions as version (version.revision)}
              <li>
                <small>{describeVersion(version, view?.sessions ?? {})} · {ago(version.at)}</small>
                {#if version.content}<span>{version.content}</span>{/if}
                {#if version.content && version.content !== entry.content}
                  <button
                    class="button ghost small"
                    type="button"
                    disabled={!!busy}
                    onclick={() =>
                      act(entry.id, () => memoryApi.restore(entry.id, version.revision))}
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
  .memory-list > li.proposal {
    border: 1px solid var(--line);
    background: transparent;
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
  .chat-link {
    padding: 0;
    border: 0;
    color: var(--accent);
    background: none;
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
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

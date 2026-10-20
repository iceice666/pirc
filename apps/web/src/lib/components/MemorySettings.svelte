<script lang="ts">
  import { tr } from '../i18n.svelte';

  /**
   * The assistant's memory (docs/architecture/assistant-memory.md): approve or reject what it
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

  const ACTION: Record<MemoryProposal['action'], string> = $derived({
    add: tr('Remember'),
    replace: tr('Change'),
    remove: tr('Forget'),
  });
  const number = (value: number) => value.toLocaleString();
  const message = (cause: unknown) =>
    cause instanceof ApiError ? cause.message : tr('Unable to reach the gateway. Try again.');

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
  <h3 id="memory-title">{tr('Memory')}</h3>
  <p>
    {tr('What your assistant remembers across chats.')} <strong>{tr('USER')}</strong>
    {tr('is what you told it about yourself and changes only when you approve.')}
    <strong>{tr('MEMORY')}</strong>
    {tr(
      "holds the assistant's own notes. New chats start with both; open chats keep what they started with. USER also reaches every new coding session on every node, so approve only what should apply everywhere.",
    )}
  </p>

  {#if disabled}
    <p role="status">{tr('Memory is unavailable in demo mode.')}</p>
  {:else if loading}
    <p role="status">{tr('Loading memory…')}</p>
  {:else}
    {#if error}<p class="memory-error" role="alert">{error}</p>{/if}
    {#if view}
      <p class="memory-usage">
        {tr('USER {0}/{1} characters · MEMORY {2}/{3} characters', [
          number(view.usage.user.used),
          number(view.usage.user.max),
          number(view.usage.note.used),
          number(view.usage.note.max),
        ])}
      </p>

      {#if view.proposals.length}
        <h4>{tr('Waiting for you')}</h4>
        <ul class="memory-list" aria-label={tr('Waiting for you')}>
          {#each view.proposals as proposal (proposal.id)}
            <li class="proposal">
              <div class="memory-row">
                <div class="memory-text">
                  <span
                    ><strong>{ACTION[proposal.action]}:</strong>
                    {proposal.content ?? proposal.target?.content ?? ''}</span
                  >
                  {#if proposal.action === 'replace' && proposal.target}
                    <small>{tr('Now: {0}', [proposal.target.content])}</small>
                  {/if}
                  <small
                    >{tr('You said “{0}” ·', [proposal.quote])}
                    {@render chat(proposal.sessionId)} · {ago(proposal.createdAt)}</small
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
                      )}>{tr('Approve')}</button
                  >
                  <button
                    class="button ghost small"
                    type="button"
                    disabled={!!busy}
                    onclick={() => act(proposal.id, () => memoryApi.reject(proposal.id))}
                    >{tr('Reject')}</button
                  >
                </div>
              </div>
            </li>
          {/each}
        </ul>
      {/if}

      <h4>{tr('About you · USER')}</h4>
      {#if view.user.length}
        {@render entries(view.user, 'About you')}
      {:else}
        <p>
          {tr('Nothing yet. When you tell the assistant about yourself, it asks you here first.')}
        </p>
      {/if}

      <h4>{tr("The assistant's notes · MEMORY")}</h4>
      {#if view.notes.length}
        {@render entries(view.notes, "The assistant's notes")}
      {:else}
        <p>{tr('No notes yet.')}</p>
      {/if}

      {#if view.removed.length}
        <details class="memory-removed">
          <summary>{tr('Removed · {0}', [view.removed.length])}</summary>
          {@render entries(view.removed, 'Removed')}
        </details>
      {/if}

      <p class="memory-fine-print">
        {tr(
          'Forget erases an entry with all its versions and keeps the same text from being saved again; rewordings are not caught. The chats it came from stay on the chat node, chats and coding sessions already started keep the USER they started with, and repositories keep their own workspace memory.',
        )}
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
    {tr('a chat that is gone')}
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
                {tr('— you said “{0}”', [entry.sources.quote])}{/if} · {@render chat(
                entry.sources.sessionId,
              )} · {ago(entry.updatedAt)}</small
            >
          </div>
          <div class="memory-actions">
            {#if entry.status === 'removed'}
              <button
                class="button ghost small"
                type="button"
                disabled={!!busy}
                onclick={() => act(entry.id, () => memoryApi.restore(entry.id))}
                >{tr('Restore')}</button
              >
            {:else}
              <button
                class="button ghost small"
                type="button"
                aria-expanded={historyFor === entry.id}
                onclick={() => toggleHistory(entry)}>{tr('History')}</button
              >
            {/if}
            {#if confirming === entry.id}
              <button
                class="button ghost small forget"
                type="button"
                disabled={!!busy}
                onclick={() => act(entry.id, () => memoryApi.forget(entry.id))}
                >{tr('Forget for good')}</button
              >
              <button
                class="button ghost small"
                type="button"
                onclick={() => (confirming = undefined)}>{tr('Cancel')}</button
              >
            {:else}
              <button
                class="button ghost small"
                type="button"
                disabled={!!busy}
                onclick={() => (confirming = entry.id)}>{tr('Forget')}</button
              >
            {/if}
          </div>
        </div>
        {#if historyFor === entry.id}
          <ol class="memory-history" aria-label={tr('History')}>
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
                    >{tr('Restore this')}</button
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

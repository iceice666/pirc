<script lang="ts">
  /**
   * Delete a chat project: what goes, what stays, and a decision for each
   * memory entry that mixes the project's text with other chats'
   * (docs/guides/chat-projects.md, "Deleting a project").
   */
  import { app } from '../../app.svelte';
  import { errorMessage } from '../../errors';
  import { ApiError } from '../../http';
  import {
    projectDeletionApi,
    type ProjectDeletionPreview,
    type ProjectMemoryDecision,
    type ProjectMemoryItem,
  } from '../../project-deletion';
  import type { Workspace } from '../../types';
  import Modal from './Modal.svelte';

  let { workspace = $bindable() }: { workspace?: Workspace } = $props();
  let open = $state(false);
  let busy = $state(false);
  let error = $state('');
  let preview: ProjectDeletionPreview | undefined = $state();
  let loading = $state(false);
  type Choice = 'forget' | 'keep' | 'edit';
  let choices = $state<Record<string, Choice>>({});
  let edits = $state<Record<string, string>>({});
  let generation = 0;

  $effect(() => {
    if (workspace) {
      open = true;
      error = '';
      void load(workspace.id);
    }
  });
  $effect(() => {
    if (!open && !busy) {
      workspace = undefined;
      preview = undefined;
    }
  });

  async function load(id: string, notice = '') {
    const current = ++generation;
    loading = true;
    try {
      const next = await projectDeletionApi.preview(id);
      if (current !== generation) return;
      preview = next;
      choices = {};
      edits = Object.fromEntries(next.memory.map((item) => [item.entry.id, item.entry.content]));
      error = notice;
    } catch (cause) {
      if (current !== generation) return;
      error = errorMessage(cause, 'Could not load what this project holds.');
    } finally {
      if (current === generation) loading = false;
    }
  }

  const of = (action: ProjectMemoryItem['action']) =>
    preview?.memory.filter((item) => item.action === action) ?? [];
  const forgotten = $derived(of('forget'));
  const rolledBack = $derived(of('rollback'));
  const review = $derived(of('review'));
  const decided = $derived(
    review.every(
      (item) =>
        choices[item.entry.id] &&
        (choices[item.entry.id] !== 'edit' || edits[item.entry.id]?.trim()),
    ),
  );
  const plural = (count: number, one: string, many = `${one}s`) =>
    `${count} ${count === 1 ? one : many}`;

  function decisions(): ProjectMemoryDecision[] {
    return review.map((item) => {
      const choice = choices[item.entry.id]!;
      const base = { entryId: item.entry.id, revision: item.entry.revision };
      return choice === 'edit'
        ? { ...base, action: 'edit', content: edits[item.entry.id]!.trim() }
        : { ...base, action: choice };
    });
  }

  async function remove() {
    if (!workspace || !preview || busy || !decided) return;
    busy = true;
    error = '';
    const id = workspace.id;
    try {
      await app.deleteProject(id, decisions());
      open = false;
      workspace = undefined;
    } catch (cause) {
      open = true;
      if (cause instanceof ApiError && cause.status === 409 && cause.code === 'conflict')
        await load(id, 'Memory changed since this was shown. Review it again.');
      else {
        // The project may be fenced now: show what is left, and the page its state.
        void app.refreshNodes();
        await load(
          id,
          errorMessage(cause, 'Could not delete this project. Reconnect the chat node and retry.'),
        );
      }
    } finally {
      busy = false;
    }
  }
</script>

<Modal bind:open labelledby="delete-project-title" class="wide">
  <header><h2 id="delete-project-title">Delete project “{workspace?.displayName}”?</h2></header>
  <div class="scroll">
    {#if loading && !preview}
      <p>Loading what the project holds…</p>
    {:else if preview}
      {#if preview.deleting}
        <p class="notice">
          An earlier deletion of this project did not finish. Deleting again completes it; entries
          you kept come up for a decision again.
        </p>
      {/if}
      <h3>Deleted</h3>
      <ul>
        <li>
          {plural(preview.chats.length, 'chat')}, with their messages, working files, uploads and
          private transcripts
        </li>
        <li>
          The project's instructions, files, capability settings{#if preview.links}
            and its links to {plural(preview.links, 'workspace')}{/if}
        </li>
        {#if preview.schedules.length}
          <li>
            {plural(preview.schedules.length, 'schedule')} that run here: {preview.schedules
              .map((schedule) => `“${schedule.title}”`)
              .join(', ')}
          </li>
        {/if}
        {#if preview.delegations}
          <li>The records of {plural(preview.delegations, 'delegated task')} its chats started</li>
        {/if}
        {#if forgotten.length}
          <li>
            {plural(forgotten.length, 'memory entry', 'memory entries')} written only here:
            <ul class="entries">
              {#each forgotten as item (item.entry.id)}<li>“{item.entry.content}”</li>{/each}
            </ul>
          </li>
        {/if}
        {#if rolledBack.length}
          <li>
            The project's changes to {plural(rolledBack.length, 'memory entry', 'memory entries')},
            which go back to their earlier text:
            <ul class="entries">
              {#each rolledBack as item (item.entry.id)}
                <li>“{item.entry.content}” → “{item.restored}”</li>
              {/each}
            </ul>
          </li>
        {/if}
      </ul>

      {#if review.length}
        <h3>Needs your decision</h3>
        <p>
          These entries mix text from this project with text from other chats, which cannot be
          separated automatically.
        </p>
        <ul class="review">
          {#each review as item (item.entry.id)}
            {@const id = item.entry.id}
            <li>
              <p class="entry">“{item.entry.content}”</p>
              <div class="choices" role="radiogroup" aria-label="What to do with this entry">
                {#each [{ value: 'forget', label: 'Forget' }, { value: 'keep', label: 'Keep as is' }, { value: 'edit', label: 'Edit' }] as option (option.value)}
                  <label class="choice">
                    <input
                      type="radio"
                      name="choice-{id}"
                      value={option.value}
                      checked={choices[id] === option.value}
                      onchange={() => (choices = { ...choices, [id]: option.value as Choice })}
                    />
                    {option.label}
                  </label>
                {/each}
              </div>
              {#if choices[id] === 'edit'}
                <textarea
                  aria-label="New text"
                  maxlength="1000"
                  value={edits[id]}
                  oninput={(event) =>
                    (edits = {
                      ...edits,
                      [id]: (event.currentTarget as HTMLTextAreaElement).value,
                    })}
                ></textarea>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      <h3>Not deleted</h3>
      <ul>
        {#if preview.keptSchedules.length}
          <li>
            Schedules its chats created in other workspaces: {preview.keptSchedules
              .map(
                (schedule) =>
                  `“${schedule.title}” (${schedule.workspaceName ?? schedule.workspaceId})`,
              )
              .join(', ')}
          </li>
        {/if}
        <li>
          Work done by delegated tasks in other workspaces: their sessions, files, commits and the
          workspace memory they wrote
        </li>
        <li>
          Copies in other chats (what they already read, and anything they wrote in their own words)
        </li>
        <li>Files uploaded before this version of pirc, which do not record their project</li>
        <li>Backups, logs and what model providers keep</li>
      </ul>
      <p>
        Forgotten text is not blocked: other chats may write it again. To keep a fact from coming
        back, forget it in Settings → Memory.
      </p>
      {#if !preview.nodeOnline}
        <p role="alert">Connect the chat node to delete this project.</p>
      {/if}
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
  </div>
  <footer>
    <button class="button ghost" type="button" disabled={busy} onclick={() => (open = false)}
      >Cancel</button
    >
    <button
      class="button dark"
      type="button"
      disabled={busy || loading || !preview || !preview.nodeOnline || !decided}
      onclick={remove}>{busy ? 'Deleting…' : 'Delete project'}</button
    >
  </footer>
</Modal>

<style>
  h2 {
    margin: 0;
    font-size: 20px;
    overflow-wrap: anywhere;
  }
  h3 {
    margin: 18px 0 6px;
    font-size: 14px;
  }
  .scroll {
    max-height: min(60dvh, 560px);
    overflow-y: auto;
  }
  p,
  li {
    color: var(--text-2);
    font-size: 14px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  ul {
    margin: 0;
    padding-left: 20px;
  }
  .entries {
    margin-top: 2px;
  }
  .review {
    padding: 0;
    list-style: none;
  }
  .review > li {
    margin: 8px 0;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    background: var(--bg-subtle);
  }
  .entry {
    margin: 0 0 6px;
    color: var(--text);
  }
  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
  }
  .choice {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 0;
  }
  .choice input {
    width: auto;
    height: auto;
  }
  textarea {
    box-sizing: border-box;
    width: 100%;
    min-height: 64px;
    margin-top: 8px;
    padding: 8px 10px;
    border: 0;
    border-radius: var(--radius-md);
    background: var(--bg-layer);
    font: inherit;
    font-size: 14px;
  }
  .notice,
  p[role='alert'] {
    color: var(--danger);
  }
</style>

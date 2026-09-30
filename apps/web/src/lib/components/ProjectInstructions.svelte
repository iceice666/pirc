<script lang="ts">
  import { ApiError } from '../http';
  import { instructionsApi } from '../capabilities';

  /** Default until the node reports its limit. */
  const DEFAULT_MAX = 8000;

  let { workspaceId }: { workspaceId: string } = $props();
  let text = $state('');
  let saved = $state('');
  let maxChars = $state(DEFAULT_MAX);
  let loaded = $state(false);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state('');
  let status = $state('');
  let reload = $state(0);
  let generation = 0;
  const message = (cause: unknown) =>
    cause instanceof ApiError ? cause.message : 'Unable to reach the gateway. Try again.';
  const tooLong = $derived(text.length > maxChars);
  const changed = $derived(text.trim() !== saved);

  $effect(() => {
    const id = workspaceId;
    void reload;
    const current = ++generation;
    loaded = false;
    loading = true;
    saving = false;
    error = '';
    status = '';
    void instructionsApi.get(id).then(
      (response) => {
        if (current !== generation) return;
        text = saved = response.instructions.text;
        maxChars = response.instructions.maxChars || DEFAULT_MAX;
        loaded = true;
        loading = false;
      },
      (cause) => {
        if (current !== generation) return;
        error = message(cause);
        loading = false;
      },
    );
    return () => {
      generation++;
    };
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!loaded || saving || tooLong || !changed) return;
    const current = generation;
    saving = true;
    error = '';
    status = '';
    try {
      const response = await instructionsApi.update(workspaceId, text);
      if (current !== generation) return;
      text = saved = response.instructions.text;
      status = 'Project instructions saved. New chats in this project will use them.';
    } catch (cause) {
      if (current === generation) error = message(cause);
    } finally {
      if (current === generation) saving = false;
    }
  }
</script>

<section class="settings-section">
  <h3>Project instructions</h3>
  <p>
    Instructions for every chat in this project. Only you can change them: the assistant cannot edit
    them. They are kept on the project's node, and each chat keeps the instructions it started with,
    so a change reaches new chats only.
  </p>
  {#if loading}
    <p role="status">Loading project instructions…</p>
  {:else if loaded}
    <form onsubmit={save}>
      <label class="instructions">
        <span>Instructions</span>
        <textarea
          bind:value={text}
          rows="8"
          disabled={saving}
          aria-invalid={tooLong}
          aria-describedby="project-instructions-count"
          placeholder="For example: answer in French, and keep trip plans on a budget."
        ></textarea>
      </label>
      <div class="row">
        <span id="project-instructions-count" class:over={tooLong}
          >{text.length} / {maxChars} characters</span
        >
        <button class="button" type="submit" disabled={saving || tooLong || !changed}
          >{saving ? 'Saving…' : 'Save'}</button
        >
      </div>
    </form>
  {/if}
  {#if error}
    <p role="alert">{error}</p>
    {#if !loaded}<button class="button ghost" type="button" onclick={() => reload++}>Retry</button
      >{/if}
  {/if}
  <p role="status">{status}</p>
</section>

<style>
  .instructions {
    display: grid;
    gap: 6px;
    margin-top: 16px;
  }
  textarea {
    width: 100%;
    resize: vertical;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 8px;
    color: var(--text-2);
    font-size: 13px;
  }
  .over {
    color: var(--danger);
  }
  [role='alert'] {
    color: var(--danger);
  }
</style>

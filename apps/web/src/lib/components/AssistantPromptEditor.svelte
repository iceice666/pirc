<script lang="ts">
  import { assistantPromptsApi, type AssistantPrompt, type PromptName } from '../assistant-prompts';
  let { name, prompt, nodeId }: { name: PromptName; prompt: AssistantPrompt; nodeId: string } =
    $props();
  // The parent keys each editor by the fetched snapshot; drafts must not reset on save.
  let text = $state((() => prompt.text)());
  let saved = $state((() => prompt)());
  let saving = $state(false);
  let error = $state('');
  let status = $state('');
  const title = $derived(name === 'soul' ? 'Soul' : 'Chat rules');
  const changed = $derived(text.replace(/\r\n/g, '\n').trim() !== saved.text);
  const tooLong = $derived(text.length > saved.maxChars);
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (saving || !saved.writable || !changed || tooLong) return;
    saving = true;
    error = '';
    status = '';
    try {
      saved = (await assistantPromptsApi.update(name, text, nodeId)).prompt;
      text = saved.text;
      status = 'Saved. Applies at the next chat agent start.';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Unable to save prompt.';
      // A file may have become managed/read-only since the editor opened.
      try {
        const latest = await assistantPromptsApi.get();
        if (latest.nodeId === nodeId) saved = latest[name];
      } catch {
        /* Keep the draft for retry. */
      }
    } finally {
      saving = false;
    }
  }
</script>

<form onsubmit={save} class="settings-section">
  <h3>{title}</h3>
  <p><code>{saved.path}</code></p>
  {#if !saved.writable}
    <p role="status">
      {#if saved.reason === 'nix-store'}Managed by Nix: edit <code
          >services.pirc.{name === 'soul' ? 'soulPrompt' : 'chatPrompt'}</code
        >.{:else if saved.reason === 'symlink'}Managed symlink: edit its source file.{:else}Read-only:
        the node does not have permission to edit this file.{/if}
    </p>
  {/if}
  <label>
    <span>{title}</span>
    <textarea
      bind:value={text}
      rows="8"
      readonly={!saved.writable}
      disabled={saving}
      aria-invalid={tooLong}
      aria-describedby="{name}-prompt-count"
    ></textarea>
  </label>
  <div class="actions">
    <span id="{name}-prompt-count" class:over={tooLong}
      >{text.length} / {saved.maxChars} characters</span
    >
    <button
      type="button"
      class="button ghost"
      disabled={saving || !changed}
      onclick={() => {
        text = saved.text;
        error = '';
        status = '';
      }}>Revert</button
    >
    <button type="submit" class="button" disabled={saving || !saved.writable || !changed || tooLong}
      >{saving ? 'Saving…' : 'Save'}</button
    >
  </div>
  {#if error}<p role="alert">{error}</p>{/if}
  <p role="status">{status}</p>
</form>

<style>
  label {
    display: grid;
    gap: 6px;
  }
  textarea {
    width: 100%;
    resize: vertical;
  }
  code {
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
  }
  .actions span {
    flex: 1;
    font-size: 13px;
    color: var(--text-2);
  }
  .actions .over,
  [role='alert'] {
    color: var(--danger);
  }
</style>

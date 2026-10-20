<script lang="ts">
  import { tr } from '../i18n.svelte';

  import { ApiError } from '../http';
  import { projectFilesApi, type ProjectFile } from '../capabilities';

  let { workspaceId }: { workspaceId: string } = $props();
  let files: ProjectFile[] = $state([]);
  let maxFiles = $state(50);
  let maxBytes = $state(0);
  let loaded = $state(false);
  let loading = $state(false);
  let busy = $state(false);
  let confirming = $state('');
  let error = $state('');
  let status = $state('');
  let reload = $state(0);
  let input: HTMLInputElement | undefined = $state();
  let generation = 0;
  const message = (cause: unknown) =>
    cause instanceof ApiError ? cause.message : tr('Unable to reach the gateway. Try again.');

  function size(bytes: number) {
    if (bytes < 1024) return tr('{0} B', [bytes]);
    if (bytes < 1024 * 1024) return tr('{0} KB', [(bytes / 1024).toFixed(1)]);
    return tr('{0} MB', [(bytes / (1024 * 1024)).toFixed(1)]);
  }

  $effect(() => {
    const id = workspaceId;
    void reload;
    const current = ++generation;
    loaded = false;
    loading = true;
    busy = false;
    confirming = '';
    error = '';
    status = '';
    void projectFilesApi.list(id).then(
      (response) => {
        if (current !== generation) return;
        files = response.files ?? [];
        maxFiles = response.maxFiles ?? 50;
        maxBytes = response.maxBytes ?? 0;
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

  async function refresh(current: number) {
    const response = await projectFilesApi.list(workspaceId);
    if (current !== generation) return;
    files = response.files ?? [];
    maxFiles = response.maxFiles ?? 50;
    maxBytes = response.maxBytes ?? 0;
  }

  async function upload(chosen: FileList | null) {
    const picked = [...(chosen ?? [])];
    if (input) input.value = '';
    if (!loaded || busy || picked.length === 0) return;
    const current = generation;
    busy = true;
    error = '';
    status = '';
    let uploaded = 0;
    try {
      for (const file of picked) {
        if (maxBytes && file.size > maxBytes) {
          error = tr('{0} is larger than the {1} limit.', [file.name, size(maxBytes)]);
          continue;
        }
        if (file.size === 0) {
          error = tr('{0} is empty.', [file.name]);
          continue;
        }
        try {
          await projectFilesApi.upload(workspaceId, file);
          uploaded++;
        } catch (cause) {
          if (current !== generation) return;
          error = `${file.name}: ${message(cause)}`;
        }
      }
      if (current !== generation) return;
      await refresh(current);
      if (uploaded) {
        status = tr('{0} uploaded. Every chat in this project can read {1} now.', [
          uploaded === 1 ? '1 file' : `${uploaded} files`,
          uploaded === 1 ? 'it' : 'them',
        ]);
      }
    } catch (cause) {
      if (current === generation) error = message(cause);
    } finally {
      if (current === generation) busy = false;
    }
  }

  async function remove(name: string) {
    if (busy) return;
    const current = generation;
    busy = true;
    error = '';
    status = '';
    confirming = '';
    try {
      await projectFilesApi.remove(workspaceId, name);
      if (current !== generation) return;
      await refresh(current);
      status = tr('{0} removed.', [name]);
    } catch (cause) {
      if (current === generation) error = message(cause);
    } finally {
      if (current === generation) busy = false;
    }
  }
</script>

<section class="settings-section">
  <h3>{tr('Project files')}</h3>
  <p>
    {tr(
      "Files every chat in this project can read, for example notes, documents or data the assistant should know about. The assistant cannot change them. They are kept on the project's node and shared with running chats at once: an upload, a replacement or a removal reaches chats already open. Uploading a file with the same name as an existing one replaces it.",
    )}
  </p>
  {#if loading}
    <p role="status">{tr('Loading project files…')}</p>
  {:else if loaded}
    {#if files.length}
      <ul class="files" aria-label={tr('Project files')}>
        {#each files as file (file.name)}
          <li>
            <span class="name">{file.name}</span>
            <span class="size">{size(file.byteSize)}</span>
            {#if confirming === file.name}
              <span class="confirm">
                <button
                  class="button ghost danger"
                  type="button"
                  disabled={busy}
                  onclick={() => remove(file.name)}>{tr('Remove')}</button
                >
                <button
                  class="button ghost"
                  type="button"
                  disabled={busy}
                  onclick={() => (confirming = '')}>{tr('Cancel')}</button
                >
              </span>
            {:else}
              <button
                class="button ghost"
                type="button"
                disabled={busy}
                aria-label={tr('Remove {0}', [file.name])}
                onclick={() => (confirming = file.name)}>{tr('Remove…')}</button
              >
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="note">{tr('No files yet.')}</p>
    {/if}
    <div class="row">
      <span
        >{tr('{0} / {1} files{2}', [
          files.length,
          maxFiles,
          maxBytes ? tr(', up to {0} each', [size(maxBytes)]) : '',
        ])}</span
      >
      <label class="button" class:disabled={busy || files.length >= maxFiles}>
        {busy ? tr('Working…') : tr('Upload files')}
        <input
          bind:this={input}
          class="sr-only"
          type="file"
          multiple
          disabled={busy || files.length >= maxFiles}
          onchange={(event) => upload(event.currentTarget.files)}
        />
      </label>
    </div>
  {/if}
  {#if error}
    <p role="alert">{error}</p>
    {#if !loaded}<button class="button ghost" type="button" onclick={() => reload++}
        >{tr('Retry')}</button
      >{/if}
  {/if}
  <p role="status">{status}</p>
</section>

<style>
  .files {
    display: grid;
    gap: 6px;
    margin: 16px 0 0;
    padding: 0;
    list-style: none;
  }
  .files li {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .size {
    color: var(--text-2);
    font-size: 13px;
  }
  .confirm {
    display: flex;
    gap: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 12px;
    color: var(--text-2);
    font-size: 13px;
  }
  .disabled {
    opacity: 0.5;
    pointer-events: none;
  }
  [role='alert'] {
    color: var(--danger);
  }
</style>

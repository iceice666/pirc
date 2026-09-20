<script lang="ts">
  import { ArrowUp, Image, LoaderCircle, Paperclip, Square, Trash2, X } from '@lucide/svelte';
  import type {
    Attachment,
    CommandKind,
    ConnectionState,
    ModelOption,
    RunStatus,
    ThinkingLevel,
  } from '../types';

  export let value = '';
  export let connection: ConnectionState;
  export let runStatus: RunStatus | undefined;
  export let hasControl: boolean;
  export let models: ModelOption[];
  export let modelId = '';
  export let thinking: ThinkingLevel = 'medium';
  export let attachments: Array<Attachment & { preview?: string; uploading?: boolean }> = [];
  export let queueCount = 0;
  export let busy = false;
  export let onvalue: (value: string) => void;
  export let onsubmit: (kind: CommandKind) => void;
  export let onupload: (files: FileList) => void;
  export let onremove: (id: string) => void;
  export let onmodel: (id: string) => void;
  export let onthinking: (level: ThinkingLevel) => void;
  export let onstop: () => void;
  export let onclear: () => void;

  let mode: CommandKind = 'prompt';
  let fileInput: HTMLInputElement;

  $: active =
    runStatus === 'running' ||
    runStatus === 'waiting_input' ||
    runStatus === 'queued' ||
    runStatus === 'stopping';
  $: if (active && mode === 'prompt') mode = 'steer';
  $: if (!active && (mode === 'steer' || mode === 'follow_up')) mode = 'prompt';
  $: canSubmit =
    value.trim().length > 0 &&
    connection === 'connected' &&
    hasControl &&
    !busy &&
    !attachments.some((item) => item.uploading);
  $: placeholder =
    connection === 'offline'
      ? 'Offline draft — it will stay on this device'
      : !hasControl
        ? 'Take control to send a message'
        : mode === 'steer'
          ? 'Steer the current run…'
          : mode === 'follow_up'
            ? 'Queue what should happen next…'
            : 'Tell Pi what to work on…';

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (canSubmit) onsubmit(mode);
    }
  }
</script>

<div class="composer-wrap">
  {#if active || queueCount > 0}
    <div class="run-controls">
      {#if active}
        <div class="mode-switch" aria-label="Message delivery mode">
          <button class:active={mode === 'steer'} type="button" on:click={() => (mode = 'steer')}
            >Steer now</button
          >
          <button
            class:active={mode === 'follow_up'}
            type="button"
            on:click={() => (mode = 'follow_up')}>Follow up</button
          >
        </div>
      {/if}
      <span class="spacer"></span>
      {#if queueCount > 0}
        <button class="text-action" type="button" on:click={onclear} disabled={!hasControl}>
          <Trash2 size={14} /> Clear queue · {queueCount}
        </button>
      {/if}
      {#if active}
        <button
          class="stop-action"
          type="button"
          on:click={onstop}
          disabled={!hasControl || runStatus === 'stopping'}
        >
          <Square size={12} fill="currentColor" />
          {runStatus === 'stopping' ? 'Stopping…' : 'Stop run'}
        </button>
      {/if}
    </div>
  {/if}

  <div class:offline={connection === 'offline'} class="composer">
    {#if connection === 'offline'}
      <div class="offline-note">
        You’re offline. This draft is saved locally and will never be sent automatically.
      </div>
    {/if}
    {#if attachments.length}
      <div class="attachment-strip" aria-label="Attached images">
        {#each attachments as attachment}
          <div class="attachment-preview">
            {#if attachment.preview}<img src={attachment.preview} alt="" />{:else}<Image
                size={22}
              />{/if}
            <span>{attachment.uploading ? 'Uploading…' : attachment.name}</span>
            {#if attachment.uploading}<LoaderCircle class="spin" size={15} />{:else}<button
                type="button"
                aria-label="Remove {attachment.name}"
                on:click={() => onremove(attachment.id)}><X size={14} /></button
              >{/if}
          </div>
        {/each}
      </div>
    {/if}
    <label class="sr-only" for="prompt">Message</label>
    <textarea
      id="prompt"
      rows="2"
      {placeholder}
      {value}
      on:input={(event) => onvalue(event.currentTarget.value)}
      on:keydown={keydown}
    ></textarea>
    <div class="composer-tools">
      <input
        class="sr-only"
        bind:this={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        on:change={(event) => event.currentTarget.files && onupload(event.currentTarget.files)}
      />
      <button
        class="icon-button"
        type="button"
        title="Attach images"
        aria-label="Attach images"
        on:click={() => fileInput.click()}
      >
        <Paperclip size={18} />
      </button>
      <select
        aria-label="Model"
        value={modelId}
        on:change={(event) => onmodel(event.currentTarget.value)}
        disabled={active}
      >
        {#each models.filter((model) => model.available) as model}
          <option value={model.id}>{model.displayName}</option>
        {/each}
      </select>
      <span class="select-divider"></span>
      <select
        aria-label="Thinking level"
        value={thinking}
        on:change={(event) => onthinking(event.currentTarget.value as ThinkingLevel)}
      >
        <option value="off">No thinking</option>
        <option value="minimal">Minimal</option>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High thinking</option>
        <option value="xhigh">Extra high</option>
      </select>
      <span class="spacer"></span>
      <span class="send-hint">↵ send</span>
      <button
        class="send-button"
        type="button"
        on:click={() => onsubmit(mode)}
        disabled={!canSubmit}
        aria-label="Send message"
      >
        {#if busy}<LoaderCircle class="spin" size={18} />{:else}<ArrowUp
            size={19}
            strokeWidth={2.2}
          />{/if}
      </button>
    </div>
  </div>
</div>

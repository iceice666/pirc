<script lang="ts">
  import {
    ArrowUp,
    CornerDownRight,
    Image,
    ListOrdered,
    LoaderCircle,
    Navigation,
    Paperclip,
    SendHorizontal,
    Square,
    X,
  } from '@lucide/svelte';
  import { slide } from 'svelte/transition';
  import { motion } from '../motion';
  import { app } from '../app.svelte';
  import type { ThinkingLevel } from '../types';
  import { modelKey } from '../types';
  import ComposerSelect from './ComposerSelect.svelte';
  import GoalDock from './GoalDock.svelte';
  import DockSection from './DockSection.svelte';
  import TodoDock from './TodoDock.svelte';

  const value = $derived(app.draft);
  const connection = $derived(app.connection);
  const runStatus = $derived(app.runStatus);
  const hasControl = $derived(app.hasControl);
  const attachments = $derived(app.uploads);
  /** Messages waiting for the current run; shown as a dock above the input. */
  const queue = $derived(app.sessionState?.queue ?? []);
  const busy = $derived(app.commandBusy);
  const modelOptions = $derived(
    app.models
      .filter((model) => model.available)
      .map((model) => ({
        value: modelKey(model),
        label: model.displayName,
        detail: model.provider,
      })),
  );
  const thinkingOptions = [
    { value: 'off', label: 'No thinking' },
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra high' },
  ];

  let fileInput: HTMLInputElement | undefined = $state();
  let queueExpanded = $state(true);

  let active = $derived(
    runStatus === 'running' ||
      runStatus === 'waiting_input' ||
      runStatus === 'queued' ||
      runStatus === 'stopping',
  );
  /** Mid-run messages steer: they join the run once its current tool batch finishes. */
  let mode = $derived(active ? ('steer' as const) : ('prompt' as const));
  let canSubmit = $derived(
    value.trim().length > 0 &&
      connection === 'connected' &&
      hasControl &&
      !busy &&
      !attachments.some((item) => item.uploading),
  );
  let stopping = $derived(runStatus === 'stopping');
  /** During a run an empty composer's primary button stops it; typing turns it back into send. */
  let showStopPrimary = $derived(active && value.trim().length === 0 && !busy);
  $effect.pre(() => {
    if (queue.length === 0) queueExpanded = true;
  });
  let placeholder = $derived(
    connection === 'offline'
      ? 'Offline draft — it will stay on this device'
      : !hasControl
        ? 'Take control to send a message'
        : mode === 'steer'
          ? 'Steer the current run…'
          : 'Tell the agent what to work on…',
  );

  /**
   * Phone and tablet keyboards have no Shift+Enter, so there Enter inserts a
   * newline and the send button sends (the mobile convention).
   */
  const touchKeyboard = () => matchMedia('(hover: none) and (pointer: coarse)').matches;

  function keydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || touchKeyboard()) return;
    event.preventDefault();
    if (canSubmit) void app.sendCommand(mode);
  }

  /** Images pasted or dropped into the text box are attached like picked files. */
  function imageFiles(data: DataTransfer | null): File[] {
    return Array.from(data?.files ?? []).filter((file) => file.type.startsWith('image/'));
  }
  function paste(event: ClipboardEvent) {
    const files = imageFiles(event.clipboardData);
    if (!files.length) return;
    // Keep pasted text; only an image-only paste is taken over.
    if (!event.clipboardData?.getData('text/plain')) event.preventDefault();
    void app.uploadImages(files);
  }
  function drop(event: DragEvent) {
    const files = imageFiles(event.dataTransfer);
    if (!files.length) return;
    event.preventDefault();
    void app.uploadImages(files);
  }

  /**
   * `field-sizing: content` grows the textarea with its text; Safari lacks it,
   * so there the height follows `scrollHeight` (bounded by the CSS max-height).
   */
  const autoSize = typeof CSS === 'undefined' || !CSS.supports?.('field-sizing', 'content');
  let textarea: HTMLTextAreaElement | undefined = $state();
  $effect(() => {
    void value;
    if (!autoSize || !textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  });
</script>

<div class="composer-wrap">
  {#if app.goal || app.todo || queue.length > 0}
    <!-- Cards tucked on top of the composer: the goal, the task list, then queued messages. -->
    <div class="composer-dock" transition:slide={{ duration: motion(180) }}>
      {#if app.goal}<GoalDock
          goal={app.goal}
          disabled={!app.canCommand || busy}
          onaction={(action) => app.goalAction(action)}
        />{/if}
      {#if app.todo}<TodoDock list={app.todo} />{/if}
      {#if queue.length > 0}
        <DockSection label="Queued messages" class="queue-dock" bind:expanded={queueExpanded}>
          {#snippet head()}
            <ListOrdered size={14} />
            <span class="dock-title">{queue.length} queued</span>
          {/snippet}
          {#snippet actions()}
            <button
              class="dock-action"
              type="button"
              onclick={() => app.clearQueue()}
              disabled={!hasControl}>Clear</button
            >
          {/snippet}
          <ol class="dock-list">
            {#each queue as item (item.id)}
              <li>
                <span class="queue-dock-kind" title={item.kind === 'steer' ? 'Steer' : 'Follow up'}>
                  {#if item.kind === 'steer'}<Navigation size={13} />{:else}<CornerDownRight
                      size={13}
                    />{/if}
                </span>
                <span class="queue-dock-text">{item.content}</span>
                <button
                  class="queue-send-now touch-target"
                  type="button"
                  onclick={() => app.sendQueuedNow(item)}
                  disabled={!hasControl || busy}
                  aria-label="Send now: {item.content}"
                  title="Send now — interrupts the current step"
                >
                  <SendHorizontal size={14} />
                </button>
              </li>
            {/each}
          </ol>
        </DockSection>
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
      <div class="attachment-strip" role="group" aria-label="Attached images">
        {#each attachments as attachment (attachment.id)}
          <div class="attachment-preview">
            {#if attachment.preview}<img src={attachment.preview} alt="" />{:else}<Image
                size={22}
              />{/if}
            <span>{attachment.uploading ? 'Uploading…' : attachment.name}</span>
            {#if attachment.uploading}<LoaderCircle class="spin" size={15} />{:else}<button
                class="touch-target"
                type="button"
                aria-label="Remove {attachment.name}"
                onclick={() => app.removeUpload(attachment.id)}><X size={14} /></button
              >{/if}
          </div>
        {/each}
      </div>
    {/if}
    <label class="sr-only" for="prompt">Message</label>
    <textarea
      id="prompt"
      bind:this={textarea}
      rows="2"
      {placeholder}
      {value}
      oninput={(event) => app.setDraft(event.currentTarget.value)}
      onkeydown={keydown}
      onpaste={paste}
      ondrop={drop}
      ondragover={(event) => {
        if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
      }}
    ></textarea>
    <div class="composer-tools">
      <input
        class="sr-only"
        bind:this={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        onchange={(event) => {
          const input = event.currentTarget;
          if (input.files?.length) void app.uploadImages(Array.from(input.files));
          // Clear the selection so picking the same image again fires `change`.
          input.value = '';
        }}
      />
      <button
        class="icon-button"
        type="button"
        title="Attach images"
        aria-label="Attach images"
        onclick={() => fileInput?.click()}
      >
        <Paperclip size={18} />
      </button>
      <div class="model-select">
        <ComposerSelect
          label="Model"
          value={app.selectedModel}
          options={modelOptions}
          disabled={active}
          onselect={(key) => app.changeModel(key)}
        />
      </div>
      <div class="thinking-select">
        <ComposerSelect
          label="Reasoning effort"
          value={app.thinking}
          options={thinkingOptions}
          onselect={(level) => app.changeThinking(level as ThinkingLevel)}
        />
      </div>
      <span class="spacer"></span>
      <span class="send-hint">↵ send</span>
      {#if active && !showStopPrimary}
        <!-- While typing mid-run, stopping stays one click away beside send. -->
        <button
          class="stop-button secondary"
          type="button"
          onclick={() => app.stopRun()}
          disabled={!hasControl || stopping}
          aria-label="Stop run"
          title="Stop run"
        >
          <Square size={11} fill="currentColor" />
        </button>
      {/if}
      {#if showStopPrimary}
        <button
          class="send-button stop-button"
          type="button"
          onclick={() => app.stopRun()}
          disabled={!hasControl || stopping}
          aria-label={stopping ? 'Stopping run' : 'Stop run'}
          title={stopping ? 'Stopping…' : 'Stop run'}
        >
          {#if stopping}<LoaderCircle class="spin" size={18} />{:else}<Square
              size={13}
              fill="currentColor"
            />{/if}
        </button>
      {:else}
        <button
          class="send-button"
          type="button"
          onclick={() => app.sendCommand(mode)}
          disabled={!canSubmit}
          aria-label="Send message"
          title="Send message"
        >
          {#if busy}<LoaderCircle class="spin" size={18} />{:else}<ArrowUp
              size={19}
              strokeWidth={2.2}
            />{/if}
        </button>
      {/if}
    </div>
  </div>
  {#if app.statusLine.length}
    <p class="composer-status" role="status">{app.statusLine.join(' · ')}</p>
  {/if}
</div>

<style>
  .spacer {
    flex: 1;
  }
  /* ───────────── Composer ───────────── */
  .composer-wrap {
    position: relative;
    z-index: 4;
    padding: 0 32px max(16px, env(safe-area-inset-bottom));
    background: var(--bg);
  }
  .composer-wrap::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 100%;
    height: 24px;
    background: linear-gradient(to top, var(--bg), transparent);
    pointer-events: none;
  }
  /*
  * Composer dock: cards tucked on top of the composer (as in Codex and
  * DeepSeek Harness) — the agent's task list, then queued messages. Sections
  * share one surface, separated by a hairline.
  */
  .composer-dock {
    position: relative;
    width: calc(min(796px, 100%) - 40px);
    margin: 0 auto -1px;
    overflow: hidden;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    background: var(--bg-subtle);
    box-shadow: 0 0 0 1px var(--line-dark);
    clip-path: inset(-1px -1px 0 -1px);
  }
  /* Quiet extension status under the composer (e.g. compaction warm-up). */
  .composer-status {
    width: min(796px, 100%);
    margin: 6px auto 0;
    padding: 0 14px;
    overflow: hidden;
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .queue-dock-kind {
    flex: none;
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    color: var(--accent);
  }
  .queue-dock-text {
    min-width: 0;
    flex: 1;
    display: -webkit-box;
    overflow: hidden;
    color: var(--ink);
    font-size: 13px;
    line-height: 20px;
    overflow-wrap: anywhere;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .queue-send-now {
    flex: none;
    width: 26px;
    height: 26px;
    margin: -3px 0;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 50%;
    color: var(--text-2);
    background: transparent;
  }
  .queue-send-now:hover:not(:disabled) {
    color: var(--accent);
    background: var(--bg-hover);
  }
  .composer {
    position: relative;
    width: min(796px, 100%);
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    border-radius: var(--radius-panel);
    background: var(--input);
    box-shadow: var(--shadow-soft);
    transition: box-shadow 0.15s var(--ease);
  }
  .composer:focus-within {
    box-shadow:
      0 0 0 1px var(--line-strong),
      0 4px 24px rgb(15 17 21 / 8%);
  }
  .composer.offline {
    box-shadow:
      0 0 0 1px var(--danger),
      0 4px 20px rgb(15 17 21 / 6%);
  }
  .offline-note {
    padding: 8px 20px;
    color: var(--danger);
    background: var(--danger-soft);
    font-size: 12px;
  }
  .composer textarea {
    width: 100%;
    min-height: 56px;
    max-height: 240px;
    display: block;
    padding: 14px 20px 4px;
    border: 0;
    outline: 0;
    resize: none;
    color: var(--ink);
    background: transparent;
    font-size: 15px;
    line-height: 24px;
    field-sizing: content;
  }
  .composer textarea::placeholder {
    color: var(--faint);
  }
  .composer-tools {
    min-height: 52px;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 10px 10px 12px;
  }
  .composer-tools .icon-button {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    color: var(--text-2);
    box-shadow: inset 0 0 0 1px var(--line-dark);
  }
  .composer-tools .model-select,
  .composer-tools .thinking-select {
    /* Shrink labels before the send/stop controls get pushed out. */
    flex: 0 1 auto;
    min-width: 0;
  }
  .composer-tools .thinking-select {
    flex-shrink: 0;
  }
  .send-hint {
    display: none;
  }
  .send-button {
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 50%;
    color: var(--on-accent);
    background: var(--accent);
    transition: background 0.15s var(--ease);
  }
  .send-button:hover:not(:disabled) {
    background: var(--accent-hover);
  }
  .send-button:disabled {
    opacity: 1;
    color: var(--bg);
    background: var(--faint);
  }
  .send-button.stop-button {
    color: var(--bg);
    background: var(--ink);
  }
  .send-button.stop-button:hover:not(:disabled) {
    background: var(--ink);
    filter: opacity(0.82);
  }
  .send-button.stop-button:disabled {
    color: var(--bg);
    background: var(--ink);
    filter: opacity(0.55);
  }
  .stop-button.secondary {
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    margin-right: 2px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    color: var(--ink);
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--line-dark);
  }
  .stop-button.secondary:hover:not(:disabled) {
    background: var(--bg-hover);
  }
  .attachment-strip {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 12px 16px 0;
  }
  .attachment-preview {
    flex: 0 0 auto;
    height: 48px;
    max-width: 200px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px 6px 6px;
    border-radius: var(--radius-md);
    background: var(--bg-subtle);
    font-size: 12px;
  }
  .attachment-preview img {
    width: 36px;
    height: 36px;
    object-fit: cover;
    border-radius: var(--radius-sm);
  }
  .attachment-preview span {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .attachment-preview button {
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
  }
  .attachment-preview button:hover {
    background: var(--bg-hover-strong);
  }
  @media (max-width: 1100px) {
    .composer-wrap {
      padding-inline: 24px;
    }
  }
  @media (max-width: 650px) {
    .composer-wrap {
      padding: 0 8px max(8px, env(safe-area-inset-bottom));
    }
    .composer-dock {
      width: calc(100% - 24px);
    }
    .composer {
      border-radius: var(--radius-xl);
    }
    .composer textarea {
      min-height: 44px;
      max-height: 160px;
      padding: 10px 14px 0;
      line-height: 22px;
    }
    .composer-tools {
      min-height: 46px;
      gap: 4px;
      padding: 4px 6px 6px 8px;
    }
    .composer-tools .model-select {
      max-width: 112px;
    }
  }
</style>

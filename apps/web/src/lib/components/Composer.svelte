<script lang="ts">
  import {
    ArrowUp,
    ChevronDown,
    CornerDownRight,
    Image,
    ListOrdered,
    LoaderCircle,
    Navigation,
    Paperclip,
    Square,
    X,
  } from '@lucide/svelte';
  import { slide } from 'svelte/transition';
  import { app } from '../app.svelte';
  import type { CommandKind, ThinkingLevel } from '../types';
  import { modelKey } from '../types';
  import ComposerSelect from './ComposerSelect.svelte';
  import GoalDock from './GoalDock.svelte';
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

  let mode = $state<CommandKind>('prompt');
  let fileInput: HTMLInputElement | undefined = $state();
  let queueExpanded = $state(true);

  let active = $derived(
    runStatus === 'running' ||
      runStatus === 'waiting_input' ||
      runStatus === 'queued' ||
      runStatus === 'stopping',
  );
  // A run starts in steer mode; once it ends messages are prompts again.
  $effect.pre(() => {
    mode = active ? 'steer' : 'prompt';
  });
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
          : mode === 'follow_up'
            ? 'Queue what should happen next…'
            : 'Tell the agent what to work on…',
  );

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (canSubmit) void app.sendCommand(mode);
    }
  }
</script>

<div class="composer-wrap">
  {#if app.goal || app.todo || queue.length > 0}
    <!-- Cards tucked on top of the composer: the goal, the task list, then queued messages. -->
    <div class="composer-dock" transition:slide={{ duration: 180 }}>
      {#if app.goal}<GoalDock
          goal={app.goal}
          disabled={!app.canCommand || busy}
          onaction={(action) => app.goalAction(action)}
        />{/if}
      {#if app.todo}<TodoDock list={app.todo} />{/if}
      {#if queue.length > 0}
        <section class="dock-section queue-dock" aria-label="Queued messages">
          <div class="dock-head">
            <button
              class="dock-toggle"
              type="button"
              aria-expanded={queueExpanded}
              aria-controls="queue-dock-list"
              onclick={() => (queueExpanded = !queueExpanded)}
            >
              <ListOrdered size={14} />
              <span class="dock-title">{queue.length} queued</span>
              <span class:collapsed={!queueExpanded} class="dock-chevron"
                ><ChevronDown size={14} /></span
              >
            </button>
            <button
              class="dock-action"
              type="button"
              onclick={() => app.clearQueue()}
              disabled={!hasControl}>Clear</button
            >
          </div>
          {#if queueExpanded}
            <ol id="queue-dock-list" class="dock-list" transition:slide={{ duration: 160 }}>
              {#each queue as item (item.id)}
                <li>
                  <span
                    class="queue-dock-kind"
                    title={item.kind === 'steer' ? 'Steer' : 'Follow up'}
                  >
                    {#if item.kind === 'steer'}<Navigation size={13} />{:else}<CornerDownRight
                        size={13}
                      />{/if}
                  </span>
                  <span class="queue-dock-text">{item.content}</span>
                </li>
              {/each}
            </ol>
          {/if}
        </section>
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
                onclick={() => app.removeUpload(attachment.id)}><X size={14} /></button
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
      oninput={(event) => app.setDraft(event.currentTarget.value)}
      onkeydown={keydown}
    ></textarea>
    <div class="composer-tools" class:running={active}>
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
      {#if active}
        <div class="mode-switch" aria-label="Message delivery mode">
          <button
            class:active={mode === 'steer'}
            type="button"
            title="Deliver into the current run"
            onclick={() => (mode = 'steer')}>Steer</button
          >
          <button
            class:active={mode === 'follow_up'}
            type="button"
            title="Queue for after the current run"
            onclick={() => (mode = 'follow_up')}>Follow up</button
          >
        </div>
      {/if}
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
          aria-label={mode === 'follow_up' ? 'Queue message' : 'Send message'}
          title={mode === 'follow_up' ? 'Queue message' : 'Send message'}
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

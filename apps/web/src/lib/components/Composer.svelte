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
  import type {
    Attachment,
    CommandKind,
    ConnectionState,
    ModelOption,
    QueueItem,
    RunStatus,
    ThinkingLevel,
  } from '../types';
  import { modelKey } from '../types';
  import type { GoalView } from '../goal';
  import type { TodoList } from '../todo';
  import ComposerSelect from './ComposerSelect.svelte';
  import GoalDock from './GoalDock.svelte';
  import TodoDock from './TodoDock.svelte';

  interface Props {
    value?: string;
    /** The session goal, docked above the task list. */
    goal?: GoalView | undefined;
    ongoal?: (action: 'pause' | 'resume') => void;
    /** The agent's task list, docked above the queue. */
    todo?: TodoList | undefined;
    /** Remaining extension status lines (e.g. compaction), shown quietly under the input. */
    statuses?: string[];
    connection: ConnectionState;
    runStatus: RunStatus | undefined;
    hasControl: boolean;
    models: ModelOption[];
    modelId?: string;
    thinking?: ThinkingLevel;
    attachments?: Array<Attachment & { preview?: string; uploading?: boolean }>;
    /** Messages waiting for the current run; shown as a dock above the input. */
    queue?: QueueItem[];
    busy?: boolean;
    onvalue: (value: string) => void;
    onsubmit: (kind: CommandKind) => void;
    onupload: (files: FileList) => void;
    onremove: (id: string) => void;
    onmodel: (id: string) => void;
    onthinking: (level: ThinkingLevel) => void;
    onstop: () => void;
    onclear: () => void;
  }

  let {
    value = '',
    goal = undefined,
    ongoal = () => undefined,
    todo = undefined,
    statuses = [],
    connection,
    runStatus,
    hasControl,
    models,
    modelId = '',
    thinking = 'medium',
    attachments = [],
    queue = [],
    busy = false,
    onvalue,
    onsubmit,
    onupload,
    onremove,
    onmodel,
    onthinking,
    onstop,
    onclear,
  }: Props = $props();

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
      if (canSubmit) onsubmit(mode);
    }
  }
</script>

<div class="composer-wrap">
  {#if goal || todo || queue.length > 0}
    <!-- Cards tucked on top of the composer: the goal, the task list, then queued messages. -->
    <div class="composer-dock" transition:slide={{ duration: 180 }}>
      {#if goal}<GoalDock
          {goal}
          disabled={!hasControl || connection !== 'connected' || busy}
          onaction={ongoal}
        />{/if}
      {#if todo}<TodoDock list={todo} />{/if}
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
            <button class="dock-action" type="button" onclick={onclear} disabled={!hasControl}
              >Clear</button
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
                onclick={() => onremove(attachment.id)}><X size={14} /></button
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
      oninput={(event) => onvalue(event.currentTarget.value)}
      onkeydown={keydown}
    ></textarea>
    <div class="composer-tools" class:running={active}>
      <input
        class="sr-only"
        bind:this={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        onchange={(event) => event.currentTarget.files && onupload(event.currentTarget.files)}
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
          value={modelId}
          options={models
            .filter((model) => model.available)
            .map((model) => ({
              value: modelKey(model),
              label: model.displayName,
              detail: model.provider,
            }))}
          disabled={active}
          onselect={onmodel}
        />
      </div>
      <div class="thinking-select">
        <ComposerSelect
          label="Reasoning effort"
          value={thinking}
          options={[
            { value: 'off', label: 'No thinking' },
            { value: 'minimal', label: 'Minimal' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'Extra high' },
          ]}
          onselect={(level) => onthinking(level as ThinkingLevel)}
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
          onclick={onstop}
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
          onclick={onstop}
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
          onclick={() => onsubmit(mode)}
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
  {#if statuses.length}
    <p class="composer-status" role="status">{statuses.join(' · ')}</p>
  {/if}
</div>

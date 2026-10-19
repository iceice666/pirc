<script lang="ts">
  /**
   * The delegations a chat started that still run or wait for you: one card
   * each, to open the delegated session or stop it. Not a question: the chat
   * keeps going while they run.
   */
  import { Forward } from '@lucide/svelte';
  import type { ChatDelegation } from '../types';

  interface Props {
    delegations: ChatDelegation[];
    onopen: (sessionId: string) => void;
    /** Resolves to the error to show, if any. */
    onstop: (delegationId: string) => Promise<string | undefined>;
  }

  let { delegations, onopen, onstop }: Props = $props();

  let stopping: string[] = $state([]);
  let errors: Record<string, string> = $state({});

  async function stop(id: string) {
    if (stopping.includes(id)) return;
    stopping = [...stopping, id];
    delete errors[id];
    const error = await onstop(id);
    if (error) errors[id] = error;
    stopping = stopping.filter((item) => item !== id);
  }
</script>

{#if delegations.length}
  <section class="delegations" aria-label="Active delegations">
    {#each delegations as delegation (delegation.id)}
      <div class="delegation-card">
        <span class="delegation-icon"><Forward size={15} /></span>
        <div class="delegation-text">
          <strong>Delegated to {delegation.workspace} — {delegation.title}</strong>
          {#if delegation.status === 'waiting_input' || delegation.dispatch === 'auto'}
            <small
              >{[
                delegation.status === 'waiting_input' ? 'Waiting for you' : '',
                delegation.dispatch === 'auto' ? 'started automatically' : '',
              ]
                .filter(Boolean)
                .join(' · ')}</small
            >
          {/if}
          {#if errors[delegation.id]}<small role="alert">{errors[delegation.id]}</small>{/if}
        </div>
        <div class="delegation-actions">
          <button
            class="button ghost small"
            type="button"
            onclick={() => onopen(delegation.targetSessionId)}>Open</button
          >
          <button
            class="button ghost small"
            type="button"
            disabled={stopping.includes(delegation.id)}
            onclick={() => stop(delegation.id)}
            >{stopping.includes(delegation.id) ? 'Stopping…' : 'Stop'}</button
          >
        </div>
      </div>
    {/each}
  </section>
{/if}

<style>
  .delegations {
    display: grid;
    gap: 6px;
    margin: 4px 0 24px;
  }
  .delegation-card {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: var(--radius-lg);
    background: var(--bg-layer);
    box-shadow: var(--shadow-soft);
  }
  .delegation-icon {
    flex: none;
    display: grid;
    color: var(--accent);
  }
  .delegation-text {
    min-width: 0;
    flex: 1;
    display: grid;
    gap: 2px;
  }
  .delegation-text strong {
    overflow: hidden;
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .delegation-text small {
    color: var(--muted);
    font-size: 12px;
  }
  .delegation-text [role='alert'] {
    color: var(--danger);
  }
  .delegation-actions {
    flex: none;
    display: flex;
    gap: 6px;
    margin-left: auto;
  }
</style>

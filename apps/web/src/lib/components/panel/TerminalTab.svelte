<script lang="ts">
  import { Plus, SquareTerminal, X } from '@lucide/svelte';
  import { panelApi, type TerminalInfo } from '../../panel-api';
  import TerminalView from './TerminalView.svelte';

  export let sessionId: string;
  export let generation: number | undefined;
  export let hasControl: boolean;
  export let active = false;

  let terminals: TerminalInfo[] = [];
  let current: string | undefined;
  let error = '';
  let busy = false;
  let loadedFor = '';

  async function load() {
    const id = sessionId;
    try {
      const result = await panelApi.terminals(id);
      if (id !== sessionId) return;
      terminals = result.terminals;
      if (!current || !terminals.some((t) => t.id === current))
        current = terminals[terminals.length - 1]?.id;
      error = '';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Terminals are unavailable.';
    }
  }

  async function create() {
    if (!hasControl || generation === undefined) {
      error = 'Take control of the session to open a terminal.';
      return;
    }
    busy = true;
    error = '';
    try {
      const { terminal } = await panelApi.createTerminal(sessionId, generation, 80, 24);
      terminals = [...terminals.filter((t) => !t.exited), terminal];
      current = terminal.id;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Unable to open a terminal.';
    } finally {
      busy = false;
    }
  }

  async function close(terminal: TerminalInfo) {
    if (!terminal.exited) {
      if (!hasControl || generation === undefined) {
        error = 'Take control of the session to close a terminal.';
        return;
      }
      try {
        await panelApi.closeTerminal(sessionId, terminal.id, generation);
      } catch (cause) {
        if (!(cause instanceof Error && /not found/i.test(cause.message))) {
          error = cause instanceof Error ? cause.message : 'Unable to close the terminal.';
          return;
        }
      }
    }
    terminals = terminals.filter((t) => t.id !== terminal.id);
    if (current === terminal.id) current = terminals[terminals.length - 1]?.id;
  }

  function exited(id: string, exitCode: number | null) {
    terminals = terminals.map((t) => (t.id === id ? { ...t, exited: true, exitCode } : t));
  }

  $: if (sessionId !== loadedFor) {
    loadedFor = sessionId;
    terminals = [];
    current = undefined;
    void load();
  }
</script>

<div class="terminal-tab">
  <div class="terminal-strip" role="tablist" aria-label="Terminals">
    {#each terminals as terminal, index (terminal.id)}
      <div
        class="terminal-chip"
        class:active={terminal.id === current}
        class:exited={terminal.exited}
      >
        <button
          type="button"
          role="tab"
          aria-selected={terminal.id === current}
          on:click={() => (current = terminal.id)}
        >
          <SquareTerminal size={13} />{terminal.title}
          {index + 1}
        </button>
        <button
          type="button"
          class="chip-close"
          aria-label="Close terminal"
          on:click={() => close(terminal)}><X size={12} /></button
        >
      </div>
    {/each}
    <button
      class="icon-button small"
      type="button"
      aria-label="New terminal"
      disabled={busy || !hasControl}
      title={hasControl ? 'New terminal' : 'Take control to open a terminal'}
      on:click={create}><Plus size={15} /></button
    >
  </div>
  {#if error}<p class="panel-error">{error}</p>{/if}
  {#if !terminals.length}
    <div class="terminal-empty">
      <SquareTerminal size={22} />
      <p>
        Run commands in this workspace. The shell runs as the gateway’s account, just like the
        agent’s own tools.
      </p>
      <button class="button primary" type="button" disabled={busy || !hasControl} on:click={create}
        >Open terminal</button
      >
      {#if !hasControl}<p class="muted">Take control of the session to open one.</p>{/if}
    </div>
  {/if}
  {#each terminals as terminal (terminal.id)}
    <TerminalView
      {sessionId}
      {terminal}
      {generation}
      {hasControl}
      visible={active && terminal.id === current}
      onexit={(code) => exited(terminal.id, code)}
    />
  {/each}
</div>

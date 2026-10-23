<script lang="ts">
  import { Plus, SquareTerminal, X } from '@lucide/svelte';
  import { rovingFocus } from '../../a11y';
  import { errorMessage } from '../../errors';
  import { t } from '../../i18n';
  import { Loader } from '../../loader.svelte';
  import { panelApi, type TerminalInfo } from '../../panel-api';
  import { watch } from '../../watch.svelte';
  import TerminalView from './TerminalView.svelte';

  interface Props {
    sessionId: string;
    generation: number | undefined;
    hasControl: boolean;
    active?: boolean;
  }

  let { sessionId, generation, hasControl, active = false }: Props = $props();

  let terminals: TerminalInfo[] = $state([]);
  let current: string | undefined = $state();
  let error = $state('');
  let busy = $state(false);

  const listLoader = new Loader();

  async function load() {
    const id = sessionId;
    const result = await listLoader.run(
      (signal) => panelApi.terminals(id, signal),
      t('panel.terminal.unavailable'),
    );
    if (!result || id !== sessionId) return;
    terminals = result.terminals;
    if (!current || !terminals.some((t) => t.id === current))
      current = terminals[terminals.length - 1]?.id;
  }

  async function create() {
    if (!hasControl || generation === undefined) {
      error = t('panel.terminal.needControlOpen');
      return;
    }
    busy = true;
    error = '';
    try {
      const { terminal } = await panelApi.createTerminal(sessionId, generation, 80, 24);
      terminals = [...terminals.filter((t) => !t.exited), terminal];
      current = terminal.id;
    } catch (cause) {
      error = errorMessage(cause, t('panel.terminal.couldNotOpen'));
    } finally {
      busy = false;
    }
  }

  async function close(terminal: TerminalInfo) {
    if (!terminal.exited) {
      if (!hasControl || generation === undefined) {
        error = t('panel.terminal.needControlClose');
        return;
      }
      try {
        await panelApi.closeTerminal(sessionId, terminal.id, generation);
      } catch (cause) {
        if (!(cause instanceof Error && /not found/i.test(cause.message))) {
          error = errorMessage(cause, t('panel.terminal.couldNotClose'));
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

  watch(
    () => sessionId,
    () => {
      listLoader.abort();
      error = '';
      terminals = [];
      current = undefined;
      void load();
    },
    { immediate: true },
  );
</script>

<div class="terminal-tab">
  <div
    class="terminal-strip"
    role="tablist"
    aria-label={t('panel.terminal.title')}
    use:rovingFocus={{ selector: '[role="tab"]', activate: true }}
  >
    {#each terminals as terminal, index (terminal.id)}
      <div
        class="terminal-chip"
        class:active={terminal.id === current}
        class:exited={terminal.exited}
      >
        <button
          type="button"
          role="tab"
          id="terminal-tab-{terminal.id}"
          aria-controls="terminal-panel-{terminal.id}"
          aria-selected={terminal.id === current}
          tabindex={terminal.id === current ? 0 : -1}
          title={t('panel.terminal.deleteHint')}
          onclick={() => (current = terminal.id)}
          onkeydown={(event) => {
            if (event.key === 'Delete') {
              event.preventDefault();
              void close(terminal);
            }
          }}
        >
          <SquareTerminal size={13} />{terminal.title}
          {index + 1}
        </button>
        <button
          type="button"
          class="chip-close"
          tabindex="-1"
          aria-label={t('panel.terminal.closeNumbered', { count: index + 1 })}
          onclick={() => close(terminal)}><X size={12} /></button
        >
      </div>
    {/each}
    <button
      class="icon-button small"
      type="button"
      aria-label={t('panel.terminal.new')}
      disabled={busy || !hasControl}
      title={hasControl ? t('panel.terminal.new') : t('panel.terminal.newHint')}
      onclick={create}><Plus size={15} /></button
    >
  </div>
  {#if error || listLoader.error}<p class="panel-error">{error || listLoader.error}</p>{/if}
  {#if !terminals.length}
    <div class="terminal-empty">
      <SquareTerminal size={22} />
      <p>{t('panel.terminal.empty')}</p>
      <button class="button primary" type="button" disabled={busy || !hasControl} onclick={create}
        >{t('panel.terminal.open')}</button
      >
      {#if !hasControl}<p class="muted">{t('panel.terminal.needControlOne')}</p>{/if}
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

<style>
  /* Terminal */
  .terminal-tab {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .terminal-tab > .panel-error {
    margin: 8px 12px 0;
  }
  .terminal-strip {
    flex: none;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    overflow-x: auto;
    border-bottom: 1px solid var(--line);
    scrollbar-width: none;
  }
  .terminal-chip {
    flex: none;
    display: inline-flex;
    align-items: center;
    border-radius: var(--radius-sm);
    color: var(--text-2);
  }
  .terminal-chip.active {
    color: var(--ink);
    background: var(--bg-active);
  }
  .terminal-chip.exited {
    opacity: 0.6;
  }
  .terminal-chip > button {
    height: 26px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 4px 0 8px;
    border: 0;
    color: inherit;
    background: transparent;
    font-size: 12px;
  }
  .terminal-chip .chip-close {
    padding: 0 6px 0 2px;
    color: var(--muted);
  }
  .terminal-chip .chip-close:hover {
    color: var(--danger);
  }
  @media (hover: none) {
    .terminal-chip > button {
      height: 40px;
    }
    .terminal-chip .chip-close {
      padding: 0 12px 0 8px;
    }
  }
  .terminal-empty {
    display: grid;
    justify-items: center;
    gap: 10px;
    margin: auto;
    padding: 24px;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
    text-align: center;
  }
  .terminal-empty p {
    max-width: 300px;
    margin: 0;
  }
</style>

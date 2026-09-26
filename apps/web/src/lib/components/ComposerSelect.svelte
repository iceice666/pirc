<script lang="ts">
  import { Check, ChevronDown } from '@lucide/svelte';
  import { tick } from 'svelte';

  export let label: string;
  export let value: string;
  export let options: Array<{ value: string; label: string; detail?: string }>;
  export let disabled = false;
  export let onselect: (value: string) => void;

  let open = false;
  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let menu: HTMLDivElement;
  $: selected = options.find((option) => option.value === value);
  $: if (disabled) open = false;

  function close(restoreFocus = false) {
    open = false;
    if (restoreFocus) trigger?.focus();
  }

  async function show(last = false) {
    if (disabled || !options.length) return;
    open = true;
    await tick();
    const items = menu?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    const index = last
      ? options.length - 1
      : Math.max(
          0,
          options.findIndex((o) => o.value === value),
        );
    items?.[index]?.focus();
  }

  function keydown(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (!menu?.contains(event.target as Node)) return;
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault();
    items[next]?.focus();
  }
</script>

<svelte:window
  on:pointerdown={(event) => {
    if (open && !root.contains(event.target as Node)) close();
  }}
  on:focusin={(event) => {
    if (open && !root.contains(event.target as Node)) close();
  }}
  on:keydown={keydown}
/>

<div class="composer-select" bind:this={root}>
  <button
    bind:this={trigger}
    class="selector-trigger"
    class:open
    type="button"
    disabled={disabled || !options.length}
    aria-label={`${label}: ${selected?.label ?? value}`}
    aria-haspopup="menu"
    aria-expanded={open}
    title={disabled ? `${label} cannot be changed during a run` : label}
    on:click={() => (open ? close() : show())}
    on:keydown={(event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        void show(event.key === 'ArrowUp');
      }
    }}
  >
    <span>{selected?.label ?? (value || label)}</span>
    <ChevronDown size={13} />
  </button>
  {#if open}
    <div class="selector-menu" bind:this={menu} role="menu" aria-label={label}>
      <div class="selector-heading" aria-hidden="true">{label}</div>
      {#each options as option (option.value)}
        <button
          type="button"
          role="menuitemradio"
          aria-checked={option.value === value}
          tabindex={option.value === value ? 0 : -1}
          class="selector-option"
          on:click={() => {
            close(true);
            if (option.value !== value) onselect(option.value);
          }}
        >
          <span class="selector-option-text">
            <span>{option.label}</span>
            {#if option.detail}<small>{option.detail}</small>{/if}
          </span>
          <span class="selector-check">
            {#if option.value === value}<Check size={15} />{/if}
          </span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .composer-select {
    position: relative;
    min-width: 0;
    max-width: 220px;
  }
  .selector-trigger {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: 34px;
    padding: 0 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
  }
  .selector-trigger span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .selector-trigger :global(svg) {
    flex-shrink: 0;
  }
  .selector-trigger:hover:not(:disabled),
  .selector-trigger.open {
    background: var(--bg-hover);
    color: var(--ink);
  }
  .selector-trigger:focus-visible,
  .selector-option:focus-visible {
    outline: 2px solid var(--text-2);
    outline-offset: -2px;
  }
  .selector-menu {
    position: absolute;
    bottom: calc(100% + 10px);
    left: 0;
    z-index: 50;
    width: max-content;
    min-width: 220px;
    max-width: min(320px, calc(100vw - 80px));
    max-height: min(400px, 55dvh);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 6px;
    border: 1px solid var(--line-dark);
    border-radius: 14px;
    background: var(--bg-layer);
    box-shadow: 0 8px 32px rgb(0 0 0 / 16%);
  }
  .selector-heading {
    padding: 7px 10px;
    color: var(--text-2);
    font-size: 11px;
    font-weight: 500;
  }
  .selector-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    width: 100%;
    padding: 9px 10px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--ink);
    text-align: left;
    font-size: 13px;
  }
  .selector-option:hover,
  .selector-option:focus {
    background: var(--bg-hover);
  }
  .selector-option-text {
    display: grid;
    gap: 3px;
    overflow-wrap: anywhere;
  }
  .selector-option small {
    color: var(--text-2);
    font-size: 11px;
  }
  .selector-check {
    flex: 0 0 15px;
  }
  @media (max-width: 640px) {
    .composer-select {
      position: static;
      max-width: 140px;
    }
    .selector-trigger {
      padding-inline: 5px;
      font-size: 12px;
    }
    .selector-menu {
      left: 8px;
      right: 8px;
      bottom: calc(100% + 8px);
      width: auto;
      min-width: 0;
      max-width: none;
    }
  }
</style>

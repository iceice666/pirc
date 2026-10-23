<script lang="ts">
  /**
   * Which sources a room follows (plans/rewrite/09-sources.md): a room that
   * follows one hears of everything new in it when pirc wakes; other sources
   * only wake pirc when something touches an open loop.
   */
  import { Rss } from '@lucide/svelte';
  import { ApiError } from '../../http';
  import { t } from '../../i18n';
  import {
    KIND_LABELS,
    followedSources,
    sourcesApi,
    withFollowed,
    type Source,
  } from '../../sources';

  interface Props {
    roomName: string;
    scope: unknown;
    onchange: (scope: Record<string, unknown>) => Promise<void>;
  }

  let { roomName, scope, onchange }: Props = $props();

  let sources: Source[] | undefined = $state();
  let error = $state('');
  let busy = $state(false);
  const followed = $derived(followedSources(scope));

  async function load() {
    try {
      sources = (await sourcesApi.list()).sources;
      error = '';
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : t('rooms.error.gateway');
    }
  }

  async function toggle(id: string, on: boolean) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      const ids = on
        ? [...followed.filter((known) => known !== id), id]
        : followed.filter((known) => known !== id);
      await onchange(withFollowed(scope, ids));
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : t('rooms.members.couldNotChange');
    } finally {
      busy = false;
    }
  }
</script>

<details
  class="room-sources"
  ontoggle={(event) => {
    if ((event.currentTarget as HTMLDetailsElement).open) void load();
  }}
>
  <summary
    aria-label={t('rooms.sources.label', { room: roomName })}
    title={t('rooms.sources.title')}
    ><Rss size={16} />{#if followed.length}<span class="count">{followed.length}</span
      >{/if}</summary
  >
  <div class="menu">
    <strong>{t('rooms.sources.label', { room: roomName })}</strong>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if sources === undefined}
      <p>{t('common.loading')}</p>
    {:else if !sources.length}
      <p>{t('rooms.sources.none')}</p>
    {:else}
      {#each sources as source (source.id)}
        <label
          ><input
            type="checkbox"
            checked={followed.includes(source.id)}
            disabled={busy}
            onchange={(event) => toggle(source.id, event.currentTarget.checked)}
          /><span>{source.name} <small>{KIND_LABELS[source.kind]}</small></span></label
        >
      {/each}
      <p>{t('rooms.sources.note')}</p>
    {/if}
  </div>
</details>

<style>
  .room-sources {
    position: relative;
  }
  summary {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    border-radius: var(--radius-sm);
    color: var(--muted);
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:hover {
    background: var(--bg-hover);
  }
  .count {
    font-size: 12px;
  }
  .menu {
    position: absolute;
    right: 0;
    z-index: 5;
    width: 260px;
    margin-top: 4px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--bg);
    box-shadow: 0 6px 24px rgb(0 0 0 / 12%);
    font-size: 13px;
  }
  label {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 0;
  }
  small {
    color: var(--muted);
  }
  p {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 12px;
  }
  .error {
    color: var(--danger);
  }
</style>

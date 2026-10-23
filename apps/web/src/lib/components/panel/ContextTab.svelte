<script lang="ts">
  import { onDestroy } from 'svelte';
  import { engine } from '../../engine.svelte';
  import { locale, t } from '../../i18n';
  import { Loader } from '../../loader.svelte';
  import { panelApi, type ContextPanel } from '../../panel-api';
  import { watch } from '../../watch.svelte';
  let {
    sessionId,
    active = true,
    onopenfile = () => {},
  }: { sessionId: string; active?: boolean; onopenfile?: (path: string) => void } = $props();
  let value = $state.raw<ContextPanel>();
  let copied = $state('');
  const loader = new Loader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function load() {
    const id = sessionId;
    const next = await loader.run(
      (signal) => panelApi.context(id, signal),
      t('panel.context.couldNotLoad'),
    );
    if (id === sessionId && next) value = next;
  }
  watch(
    () => sessionId,
    () => {
      loader.abort();
      value = undefined;
      copied = '';
      clearTimeout(timer);
      if (active) void load();
    },
    { immediate: true },
  );
  watch(
    () => active,
    (shown) => {
      if (shown) void load();
      else {
        loader.abort();
        clearTimeout(timer);
      }
    },
  );
  watch(
    () => engine.sessionState?.runnerStatus,
    () => {
      if (active) void load();
    },
  );
  onDestroy(
    engine.onPanel((signal) => {
      if (!active || (signal.type !== 'run-finished' && !signal.sections.includes('context')))
        return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 150);
    }),
  );
  onDestroy(() => {
    loader.abort();
    clearTimeout(timer);
  });
  const snapshot = $derived(value?.snapshot);
  const segments = $derived(
    snapshot
      ? [
          ...Object.entries(snapshot.usage.buckets).map(([name, estimate]) => ({
            name,
            tokens: estimate * snapshot.usage.scale,
          })),
          { name: 'free', tokens: snapshot.usage.remaining ?? 0 },
        ]
      : [],
  );
  const total = $derived(segments.reduce((sum, item) => sum + item.tokens, 0));
  const tokens = (n: number) => Math.round(n).toLocaleString();
  async function copy() {
    if (!snapshot) return;
    try {
      await navigator.clipboard.writeText(
        snapshot.sections
          .map((s) => s.text)
          .filter(Boolean)
          .join('\n\n'),
      );
      copied = t('panel.context.copied');
    } catch {
      copied = t('panel.context.copyFailed');
    }
  }
</script>

<div class="context-tab">
  <div class="actions">
    <h3>{t('panel.context.title')}</h3>
    <button class="button ghost" type="button" disabled={loader.loading} onclick={load}
      >{t('common.refresh')}</button
    >
  </div>
  {#if loader.error}<p role="alert">{loader.error}</p>{/if}
  {#if loader.loading && !snapshot}<p role="status">{t('panel.context.loading')}</p>{/if}
  {#if snapshot && value}
    {#if !value.agentRunning || value.source === 'snapshot'}<p class="stale" role="status">
        {value.agentRunning ? t('panel.context.savedSnapshot') : t('panel.context.savedStopped')}
      </p>{/if}
    <p class="meta">
      {snapshot.model.provider} / {snapshot.model.id}<br /><time
        datetime={new Date(snapshot.takenAt).toISOString()}
        >{new Date(snapshot.takenAt).toLocaleString(locale())}</time
      >
    </p>
    <div
      class="usage-bar"
      role="img"
      aria-label={t('panel.context.usage', {
        parts: segments.map((s) => s.name + ' ' + tokens(s.tokens)).join(', '),
      })}
    >
      {#each segments as segment}<span
          class={segment.name}
          style:width="{total ? (segment.tokens / total) * 100 : 0}%"
          title="{segment.name}: {tokens(segment.tokens)}"
        ></span>{/each}
    </div>
    <ul class="legend">
      {#each segments as segment}<li>
          <i class={segment.name}></i>{segment.name}: {tokens(segment.tokens)}
        </li>{/each}
    </ul>
    <p class="meta">
      {t('panel.context.estimatedInput', { count: tokens(snapshot.usage.estimatedInput) })} ·
      {t('panel.context.reportedInput', {
        count:
          snapshot.usage.reportedInput === undefined
            ? t('panel.context.notAvailable')
            : tokens(snapshot.usage.reportedInput),
      })}<br />{t('panel.context.contextWindow', {
        count: snapshot.model.contextWindow
          ? tokens(snapshot.model.contextWindow)
          : t('panel.unknown'),
      })}
    </p>
    <p class="meta">
      {snapshot.usage.reportedInput === undefined
        ? t('panel.context.estimatesNote')
        : t('panel.context.estimatesNoteScaled')}
    </p>
    <div class="actions">
      <h4>{t('panel.context.systemSections')}</h4>
      <button type="button" class="button ghost" onclick={copy}>{t('panel.context.copyAll')}</button
      >
    </div>
    <p role="status">{copied}</p>
    {#each snapshot.sections as section, index (`${index}:${section.id}`)}
      <details>
        <summary
          >{section.title}
          <span class="meta"
            >{t('panel.context.tokens', { count: tokens(section.estimatedTokens) })}</span
          >{#if section.frozen}<span class="badge">{t('panel.context.frozen')}</span>{/if}</summary
        >
        <p class="source">
          {#if section.filePath !== undefined}<button
              type="button"
              class="link"
              onclick={() => onopenfile(section.filePath!)}>{section.source}</button
            >{:else}{section.source}{/if}
        </p>
        <pre>{section.text}</pre>
      </details>
    {/each}
    <h4>{t('panel.context.modelTools', { count: snapshot.tools.length })}</h4>
    {#each snapshot.tools as tool (tool.name)}
      <details>
        <summary
          >{tool.name}
          <span class="meta"
            >{t('panel.context.tokens', { count: tokens(tool.estimatedTokens) })}</span
          ></summary
        >
        <pre>{tool.description}</pre>
        <pre>{JSON.stringify(tool.parameters, null, 2)}</pre>
      </details>
    {/each}
    {#if snapshot.capabilities}
      <h4>{t('panel.context.capabilities', { count: snapshot.capabilities.length })}</h4>
      <p class="meta">{t('panel.context.capabilitiesNote')}</p>
      <ul class="capabilities">
        {#each snapshot.capabilities as capability (capability.name)}
          <li>
            <code>{capability.name}</code>
            <span class="meta"
              >{capability.category} · {capability.effects.join(', ')}{capability.approval !==
              'none'
                ? ` · ${capability.approval}`
                : ''}</span
            >
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .capabilities {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .capabilities li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
  }
  .actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .meta,
  .source {
    font-size: 12px;
    color: var(--text-2);
    overflow-wrap: anywhere;
  }
  .stale {
    padding: 8px;
    background: var(--bg-hover);
    border-radius: 6px;
  }
  .usage-bar {
    display: flex;
    height: 14px;
    border-radius: 4px;
    overflow: hidden;
    background: var(--line);
  }
  .system {
    background: #6f8de0;
  }
  .tools {
    background: #a37bcd;
  }
  .messages {
    background: #49a18d;
  }
  .memory {
    background: #cf9c50;
  }
  .free {
    background: var(--line);
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    padding: 0;
    list-style: none;
    font-size: 12px;
  }
  .legend i {
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 4px;
  }
  details {
    padding: 8px 0;
    border-bottom: 1px solid var(--line);
  }
  summary {
    cursor: pointer;
    overflow-wrap: anywhere;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 12px;
    line-height: 1.5;
  }
  .badge {
    margin-left: 6px;
    font-size: 10px;
    padding: 2px 5px;
    border: 1px solid var(--line);
    border-radius: 4px;
  }
  .link {
    font: inherit;
    color: var(--accent);
    text-align: left;
    overflow-wrap: anywhere;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  [role='alert'] {
    color: var(--danger);
  }
</style>

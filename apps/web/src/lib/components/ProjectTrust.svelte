<script lang="ts">
  import { ApiError } from '../http';
  import { projectTrustApi, type ProjectConfigSummary, type ProjectHook } from '../capabilities';
  import { t } from '../i18n';
  import type { MessageKey } from '../i18n/messages';

  /** A directory workspace on an online node. */
  let { workspaceId }: { workspaceId: string } = $props();
  let project: ProjectConfigSummary | undefined = $state();
  let loading = $state(false);
  let saving = $state(false);
  let error = $state('');
  let status = $state('');
  let reload = $state(0);
  let generation = 0;
  const message = (cause: unknown) =>
    cause instanceof ApiError ? cause.message : t('settings.gateway.unreachable');

  const HOOK_LABELS: Record<string, MessageKey> = {
    sessionStart: 'settings.trust.hookSessionStart',
    beforePrompt: 'settings.trust.hookBeforePrompt',
    beforeTool: 'settings.trust.hookBeforeTool',
    afterTool: 'settings.trust.hookAfterTool',
    agentSettled: 'settings.trust.hookAgentSettled',
  };
  const hookGroups = $derived(
    Object.entries(project?.hooks ?? {}).filter(([, list]) => list.length) as Array<
      [string, ProjectHook[]]
    >,
  );
  const envLines = $derived(
    Object.entries(project?.env ?? {})
      .map(([name, value]) => `${name}=${value}`)
      .join('\n'),
  );
  const changed = $derived(!!project && !project.trusted && project.trustedHash !== null);

  $effect(() => {
    const id = workspaceId;
    void reload;
    const current = ++generation;
    project = undefined;
    error = '';
    status = '';
    saving = false;
    loading = true;
    void projectTrustApi.get(id).then(
      (response) => {
        if (current !== generation) return;
        project = response.project;
        loading = false;
      },
      (cause) => {
        if (current !== generation) return;
        error = message(cause);
        loading = false;
      },
    );
    return () => {
      generation++;
    };
  });

  async function decide(trust: boolean) {
    if (!project || saving) return;
    const hash = project.hash;
    if (trust && !hash) return;
    const current = generation;
    saving = true;
    error = '';
    status = '';
    try {
      const response = trust
        ? await projectTrustApi.trust(workspaceId, hash!)
        : await projectTrustApi.revoke(workspaceId);
      if (current !== generation) return;
      project = response.project;
      status = trust ? t('settings.trust.trusted') : t('settings.trust.revoked');
    } catch (cause) {
      if (current !== generation) return;
      error = message(cause);
      // The config changed since it was shown: show the current one to review.
      if (cause instanceof ApiError && cause.status === 409)
        void projectTrustApi.get(workspaceId).then(
          (response) => {
            if (current === generation) project = response.project;
          },
          () => undefined,
        );
    } finally {
      if (current === generation) saving = false;
    }
  }
</script>

<section class="settings-section">
  <h3>{t('settings.trust.title')}</h3>
  <p>
    {t('settings.trust.introLead')} <code>.pirc/config.json</code>
    {t('settings.trust.introRest')}
  </p>
  {#if loading}
    <p role="status">{t('settings.trust.loading')}</p>
  {:else if project}
    {#if project.error !== undefined}
      <p class="problem">{t('settings.trust.invalid', { error: project.error })}</p>
    {:else if project.empty}
      <p>{t('settings.trust.empty')}</p>
    {:else}
      <p class="state" class:trusted={project.trusted} class:changed>
        {#if project.trusted}{t('settings.trust.stateTrusted')}{:else if changed}{t(
            'settings.trust.stateChanged',
          )}{:else}{t('settings.trust.stateNotTrusted')}{/if}
      </p>
      {#if hookGroups.length}
        <h4>{t('settings.trust.hooks')}</h4>
        {#each hookGroups as [event, hooks] (event)}
          <div class="hook-group">
            <span class="hook-event">{HOOK_LABELS[event] ? t(HOOK_LABELS[event]) : event}</span>
            {#each hooks as hook, index (index)}
              <pre>{hook.command}</pre>
              {#if hook.matcher}<small
                  >{t('settings.trust.matcherLead')} <code>{hook.matcher}</code></small
                >{/if}
            {/each}
          </div>
        {/each}
      {/if}
      {#if envLines}
        <h4>{t('settings.trust.environment')}</h4>
        <pre>{envLines}</pre>
      {/if}
      {#if project.allowedPaths.length}
        <h4>{t('settings.trust.allowedPaths')}</h4>
        <pre>{project.allowedPaths.join('\n')}</pre>
      {/if}
      {#if project.defaultModel}
        <h4>{t('settings.trust.defaultModel')}</h4>
        <pre>{project.defaultModel.provider}/{project.defaultModel.id}{project.defaultModel.thinking
            ? ` ${t('settings.trust.thinking', { level: project.defaultModel.thinking })}`
            : ''}</pre>
      {/if}
    {/if}
    <div class="actions">
      {#if !project.trusted && project.hash && !project.empty}
        <button class="button dark" type="button" disabled={saving} onclick={() => decide(true)}
          >{t('settings.trust.trust')}</button
        >
      {/if}
      {#if project.trustedHash !== null}
        <button class="button ghost" type="button" disabled={saving} onclick={() => decide(false)}
          >{t('settings.trust.revoke')}</button
        >
      {/if}
    </div>
  {/if}
  {#if error}
    <p role="alert">{error}</p>
    {#if !project}<button class="button ghost" type="button" onclick={() => reload++}
        >{t('common.retry')}</button
      >{/if}
  {/if}
  <p role="status">{saving ? t('common.saving') : status}</p>
</section>

<style>
  h4 {
    margin: 16px 0 6px;
    color: var(--text-2);
    font-size: 13px;
    font-weight: 600;
  }
  pre {
    margin: 4px 0 0;
    padding: 8px 10px;
    overflow-x: auto;
    border-radius: var(--radius-sm);
    background: var(--code-bg);
    color: var(--code-ink);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-all;
  }
  code {
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .hook-group + .hook-group {
    margin-top: 10px;
  }
  .hook-event {
    color: var(--muted);
    font-size: 12px;
  }
  small {
    display: block;
    margin-top: 2px;
    color: var(--muted);
    font-size: 12px;
  }
  .state {
    font-weight: 600;
  }
  .state.trusted {
    color: var(--success);
  }
  .state:not(.trusted) {
    color: var(--warning);
  }
  .problem,
  [role='alert'] {
    color: var(--danger);
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
  .actions:empty {
    display: none;
  }
</style>

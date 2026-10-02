<script lang="ts">
  import { ApiError } from '../http';
  import { projectTrustApi, type ProjectConfigSummary, type ProjectHook } from '../capabilities';

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
    cause instanceof ApiError ? cause.message : 'Unable to reach the gateway. Try again.';

  const HOOK_LABELS: Record<string, string> = {
    sessionStart: 'When a session starts',
    beforePrompt: 'Before each prompt',
    beforeTool: 'Before a tool runs',
    afterTool: 'After a tool runs',
    agentSettled: 'When the agent settles',
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
      status = trust
        ? 'Trusted. New sessions in this workspace use these hooks, environment and paths.'
        : 'Trust revoked. New sessions ignore them.';
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
  <h3>Project config</h3>
  <p>
    A repository's <code>.pirc/config.json</code> can run hook commands, set environment variables for
    every command the agent runs, and add writable paths. Agents here ignore them until you trust them.
    If the repository changes them later, they are ignored again until you trust the new values.
  </p>
  {#if loading}
    <p role="status">Loading project config…</p>
  {:else if project}
    {#if project.error !== undefined}
      <p class="problem">The project config is invalid and is not used: {project.error}</p>
    {:else if project.empty}
      <p>This workspace's project config sets no hooks, environment or allowed paths.</p>
    {:else}
      <p class="state" class:trusted={project.trusted} class:changed>
        {#if project.trusted}Trusted{:else if changed}Changed since trusted: ignored until you trust
          it again{:else}Not trusted: ignored{/if}
      </p>
      {#if hookGroups.length}
        <h4>Hooks</h4>
        {#each hookGroups as [event, hooks] (event)}
          <div class="hook-group">
            <span class="hook-event">{HOOK_LABELS[event] ?? event}</span>
            {#each hooks as hook, index (index)}
              <pre>{hook.command}</pre>
              {#if hook.matcher}<small>Only for tools matching <code>{hook.matcher}</code></small
                >{/if}
            {/each}
          </div>
        {/each}
      {/if}
      {#if envLines}
        <h4>Environment</h4>
        <pre>{envLines}</pre>
      {/if}
      {#if project.allowedPaths.length}
        <h4>Allowed paths</h4>
        <pre>{project.allowedPaths.join('\n')}</pre>
      {/if}
    {/if}
    <div class="actions">
      {#if !project.trusted && project.hash && !project.empty}
        <button class="button dark" type="button" disabled={saving} onclick={() => decide(true)}
          >Trust</button
        >
      {/if}
      {#if project.trustedHash !== null}
        <button class="button ghost" type="button" disabled={saving} onclick={() => decide(false)}
          >Revoke trust</button
        >
      {/if}
    </div>
  {/if}
  {#if error}
    <p role="alert">{error}</p>
    {#if !project}<button class="button ghost" type="button" onclick={() => reload++}>Retry</button
      >{/if}
  {/if}
  <p role="status">{saving ? 'Saving…' : status}</p>
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

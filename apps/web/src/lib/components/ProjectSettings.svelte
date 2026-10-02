<script lang="ts">
  import { ApiError } from '../http';
  import {
    capabilitiesApi,
    CAPABILITY_LABELS,
    type Capability,
    type ProjectCapabilities,
  } from '../capabilities';

  /** A chat workspace: a project, or the top-level chats. */
  let { workspaceId, disabled = false }: { workspaceId: string; disabled?: boolean } = $props();
  let capabilities: ProjectCapabilities | undefined = $state();
  let loading = $state(false);
  let saving = $state(false);
  let error = $state('');
  let status = $state('');
  let reload = $state(0);
  let generation = 0;
  const message = (cause: unknown) =>
    cause instanceof ApiError ? cause.message : 'Unable to reach the gateway. Try again.';

  $effect(() => {
    const id = workspaceId;
    const unavailable = disabled;
    void reload;
    const current = ++generation;
    capabilities = undefined;
    error = '';
    status = '';
    saving = false;
    loading = !!id && !unavailable;
    if (id && !unavailable) {
      void capabilitiesApi.get(id).then(
        (response) => {
          if (current !== generation) return;
          capabilities = response.capabilities;
          loading = false;
        },
        (cause) => {
          if (current !== generation) return;
          error = message(cause);
          loading = false;
        },
      );
    }
    return () => {
      generation++;
    };
  });

  async function toggle(key: Capability, input: HTMLInputElement) {
    if (!workspaceId || !capabilities || loading || saving || disabled) return;
    const value = input.checked;
    // Only the gateway response changes the displayed policy, never an optimistic local value.
    input.checked = capabilities[key];
    const current = generation;
    saving = true;
    error = '';
    status = '';
    try {
      const response = await capabilitiesApi.update(workspaceId, { [key]: value });
      if (current !== generation) return;
      capabilities = response.capabilities;
      status = 'Project capabilities saved.';
    } catch (cause) {
      if (current === generation) error = message(cause);
    } finally {
      if (current === generation) saving = false;
    }
  }
</script>

<section class="settings-section">
  <h3>Project capabilities</h3>
  <p>
    Choose which assistant features this chat workspace may use. All capabilities are allowed by
    default. Changes are saved to and enforced by the gateway, not just hidden in this browser.
  </p>
  <p>
    This is not a sandbox: these settings do not isolate files, shell commands, or network access.
    They do not revoke data already in a conversation or stop work already running.
  </p>
  {#if disabled}
    <p>Project capabilities are unavailable in demo mode.</p>
  {:else}
    {#if loading}
      <p role="status">Loading project capabilities…</p>
    {:else if capabilities}
      <fieldset disabled={saving} aria-busy={saving}>
        <legend>Allowed assistant features</legend>
        {#each Object.entries(CAPABILITY_LABELS) as [key, label] (key)}
          <label class="capability-toggle">
            <span>{label}</span>
            <input
              type="checkbox"
              role="switch"
              checked={capabilities[key as Capability]}
              onchange={(event) => toggle(key as Capability, event.currentTarget)}
            />
          </label>
        {/each}
      </fieldset>
    {/if}
    {#if error}
      <p role="alert">{error}</p>
      {#if !capabilities}<button class="button ghost" type="button" onclick={() => reload++}
          >Retry</button
        >{/if}
    {/if}
    <p role="status">{saving ? 'Saving project capabilities…' : status}</p>
  {/if}
</section>

<style>
  fieldset {
    margin: 16px 0 0;
    padding: 0;
    border: 0;
  }
  legend {
    margin-bottom: 8px;
    color: var(--text-2);
    font-size: 13px;
  }
  .capability-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 0;
    padding: 8px 0;
  }
  .capability-toggle input {
    width: 16px;
    height: 16px;
    flex: none;
    padding: 0;
    accent-color: var(--accent);
  }
  [role='alert'] {
    color: var(--danger);
  }
</style>

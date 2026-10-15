<script lang="ts">
  import { ApiError } from '../http';
  import { linksApi, type ProjectLink } from '../capabilities';
  import type { Workspace } from '../types';

  let {
    workspaceId,
    workspaces,
    online = () => true,
    disabled = false,
  }: {
    /** The chat project. */
    workspaceId: string;
    /** The directory workspaces it can be linked to. */
    workspaces: Workspace[];
    online?: (workspace: Workspace) => boolean;
    disabled?: boolean;
  } = $props();
  let links: ProjectLink[] | undefined = $state();
  let chosen = $state(new Set<string>());
  let loading = $state(false);
  let saving = $state(false);
  let error = $state('');
  let status = $state('');
  let reload = $state(0);
  let generation = 0;
  const message = (cause: unknown) =>
    cause instanceof ApiError ? cause.message : 'Unable to reach the gateway. Try again.';
  const saved = $derived(new Set(links?.map((link) => link.workspaceId) ?? []));
  const changed = $derived(chosen.size !== saved.size || [...chosen].some((id) => !saved.has(id)));
  /** Links to workspaces no longer listed stay visible until unchecked. */
  const missing = $derived(
    (links ?? []).filter((link) => !workspaces.some((item) => item.id === link.workspaceId)),
  );
  const linkOf = (id: string) => links?.find((link) => link.workspaceId === id);

  function show(response: { links: ProjectLink[] }) {
    links = response.links;
    chosen = new Set(response.links.map((link) => link.workspaceId));
  }

  $effect(() => {
    const id = workspaceId;
    const unavailable = disabled;
    void reload;
    const current = ++generation;
    links = undefined;
    chosen = new Set();
    error = '';
    status = '';
    saving = false;
    loading = !unavailable;
    if (!unavailable) {
      void linksApi.get(id).then(
        (response) => {
          if (current !== generation) return;
          show(response);
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

  function toggle(id: string, checked: boolean) {
    const next = new Set(chosen);
    if (checked) next.add(id);
    else next.delete(id);
    chosen = next;
    status = '';
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!links || saving || !changed || disabled) return;
    const current = generation;
    saving = true;
    error = '';
    status = '';
    try {
      // Keep the order links were made in; new ones after them.
      const ids = [
        ...links.map((link) => link.workspaceId).filter((id) => chosen.has(id)),
        ...[...chosen].filter((id) => !saved.has(id)),
      ];
      const response = await linksApi.update(workspaceId, ids);
      if (current !== generation) return;
      show(response);
      status = 'Linked workspaces saved.';
    } catch (cause) {
      if (current === generation) error = message(cause);
    } finally {
      if (current === generation) saving = false;
    }
  }

  /** Device, repository when known, and why it may not be reachable. */
  function details(workspace: Workspace) {
    const link = linkOf(workspace.id);
    const reach = link?.removed
      ? 'removed from its device'
      : (link ? link.online : online(workspace))
        ? ''
        : 'offline';
    return [workspace.hostId, link?.repo, reach].filter(Boolean).join(' · ');
  }
</script>

<section class="settings-section">
  <h3>Linked workspaces</h3>
  <p>
    The repositories this project is about. Its assistant lists them first, hands a task to the
    linked workspace when only one is linked and the task names none, and searches their notes (and
    those of other clones of the same repository) first.
  </p>
  <p>
    A link is not a permission: you still approve every delegation, and the assistant can still
    reach workspaces that are not linked. Chats already open keep the workspace list they started
    with.
  </p>
  {#if disabled}
    <p>Linked workspaces are unavailable in demo mode.</p>
  {:else}
    {#if loading}
      <p role="status">Loading linked workspaces…</p>
    {:else if links}
      <form onsubmit={save}>
        <fieldset disabled={saving} aria-busy={saving}>
          <legend>Workspaces</legend>
          {#each workspaces as workspace (workspace.id)}
            <label class="link-choice">
              <input
                type="checkbox"
                checked={chosen.has(workspace.id)}
                onchange={(event) => toggle(workspace.id, event.currentTarget.checked)}
              />
              <span class="name">{workspace.displayName}</span>
              <small>{details(workspace)}</small>
            </label>
          {:else}
            <p class="empty">No directory workspaces yet.</p>
          {/each}
          {#each missing as link (link.workspaceId)}
            <label class="link-choice">
              <input
                type="checkbox"
                checked={chosen.has(link.workspaceId)}
                onchange={(event) => toggle(link.workspaceId, event.currentTarget.checked)}
              />
              <span class="name">{link.name ?? link.workspaceId}</span>
              <small>{[link.node, 'no longer available'].filter(Boolean).join(' · ')}</small>
            </label>
          {/each}
        </fieldset>
        <div class="row">
          <span>{chosen.size} linked</span>
          <button class="button" type="submit" disabled={saving || !changed}
            >{saving ? 'Saving…' : 'Save'}</button
          >
        </div>
      </form>
    {/if}
    {#if error}
      <p role="alert">{error}</p>
      {#if !links}<button class="button ghost" type="button" onclick={() => reload++}>Retry</button
        >{/if}
    {/if}
    <p role="status">{status}</p>
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
  .link-choice {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin: 0;
    padding: 6px 0;
  }
  .link-choice input {
    width: 16px;
    height: 16px;
    flex: none;
    padding: 0;
    align-self: center;
    accent-color: var(--accent);
  }
  .link-choice small {
    color: var(--text-2);
    overflow-wrap: anywhere;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 8px;
    color: var(--text-2);
    font-size: 13px;
  }
  .empty {
    color: var(--text-2);
  }
  [role='alert'] {
    color: var(--danger);
  }
</style>

<script lang="ts">
  import {
    assistantPromptsApi,
    type AssistantBinding,
    type AssistantPrompts,
  } from '../assistant-prompts';
  import AssistantPromptEditor from './AssistantPromptEditor.svelte';
  let { disabled = false }: { disabled?: boolean } = $props();
  let binding = $state<AssistantBinding>();
  let prompts = $state<AssistantPrompts>();
  let error = $state('');
  let loading = $state(false);
  let confirming = $state(false);
  let reload = $state(0);
  $effect(() => {
    void reload;
    if (disabled) return;
    let active = true;
    loading = true;
    error = '';
    prompts = undefined;
    void (async () => {
      try {
        const result = await assistantPromptsApi.binding();
        if (!active) return;
        binding = result;
        if (result.online) {
          const result = await assistantPromptsApi.get();
          if (active) prompts = result;
        }
      } catch (cause) {
        if (active)
          error = cause instanceof Error ? cause.message : 'Unable to load assistant settings.';
      } finally {
        if (active) loading = false;
      }
    })();
    return () => {
      active = false;
    };
  });
  async function release() {
    if (!binding?.nodeId || loading) return;
    loading = true;
    error = '';
    try {
      binding = await assistantPromptsApi.release(binding.nodeId);
      prompts = undefined;
      confirming = false;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Unable to release binding.';
    } finally {
      loading = false;
    }
  }
</script>

<section class="settings-section">
  <h3>Assistant</h3>
  <p>
    Soul defines the assistant's persona; Chat rules apply to all chats. Files stay on the chat
    node. Changes apply at the next agent start (new chats or restarted agents), not to an already
    running agent. Empty Soul restores the built-in identity.
  </p>
  <p>Chats no longer read AGENTS.md: move chat-relevant rules into CHAT.md.</p>
  {#if disabled}<p>Assistant settings are unavailable in the demo.</p>
  {:else}
    {#if binding?.nodeId}
      <p>Chat node: <code>{binding.nodeId}</code> — {binding.online ? 'online' : 'offline'}</p>
      {#if confirming}
        <p>
          Stop the old chat node before releasing it, or it may reconnect and claim the binding
          again. Releasing disconnects it; the next chat node to register will be bound.
        </p>
        <button type="button" class="button" disabled={loading} onclick={release}
          >Confirm release</button
        >
        <button
          type="button"
          class="button ghost"
          disabled={loading}
          onclick={() => (confirming = false)}>Cancel</button
        >
      {:else}<button
          type="button"
          class="button ghost"
          disabled={loading}
          onclick={() => (confirming = true)}>Release chat node binding</button
        >{/if}
    {:else if !loading}<p>No chat node is bound. Start a chat node to register it.</p>{/if}
    <button type="button" class="button ghost" disabled={loading} onclick={() => reload++}
      >Refresh</button
    >
    {#if loading}<p role="status">Loading…</p>{/if}
    {#if error}<p role="alert">{error}</p>{/if}
  {/if}
</section>
{#if prompts}
  {#key prompts}
    <AssistantPromptEditor name="soul" prompt={prompts.soul} nodeId={prompts.nodeId} />
    <AssistantPromptEditor name="chat" prompt={prompts.chat} nodeId={prompts.nodeId} />
  {/key}
{/if}

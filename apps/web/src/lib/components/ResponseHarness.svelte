<script lang="ts">
  import { untrack } from 'svelte';
  import Response from './Response.svelte';
  import type { ConversationMessage } from '../types';
  let { initial }: { initial: ConversationMessage[] } = $props();
  let messages = $state(untrack(() => initial));
  export function update(next: ConversationMessage[]) {
    messages = next;
  }
</script>

<Response {messages} />

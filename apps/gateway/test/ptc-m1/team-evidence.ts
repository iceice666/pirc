/** Trusted pinned-binary functional evidence; NOT authenticated OS writer provenance.
 * Inspect only current in-memory RPC/inference data, never session files.
 */
import type { InferenceRequest } from '../../src/inference-wire.js';
import type { AssistantMessage } from '../../src/agent/messages.js';
import { isSurfaceEvent, reportedOperations, scriptOperations } from './ptc-surface.js';

export const TEAM_ORACLE_REVISION = 2; // Prospective multi-wait/read-only coordination approval.

/** Fixed tool-name buckets; anything else is `other`. Names only, never arguments. */
const TOOL_BUCKETS = [
  'write',
  'edit',
  'bash',
  'ls',
  'grep',
  'find',
  'read',
  'agent_spawn',
  'agent_wait',
  'agent_send',
  'agent_stop',
  'subagent',
] as const;
type ToolBucket = (typeof TOOL_BUCKETS)[number] | 'other';
const bucket = (name: unknown): ToolBucket =>
  TOOL_BUCKETS.includes(name as never) ? (name as ToolBucket) : 'other';
const counts = (): Record<ToolBucket, number> =>
  Object.fromEntries([...TOOL_BUCKETS, 'other'].map((name) => [name, 0])) as Record<
    ToolBucket,
    number
  >;
const TEAM_FILE = /(^|\/)team\.txt$/;

export class TeamEvidence {
  private parent = '';
  private children = new Set<string>();
  private writes = new Map<string, Set<string>>();
  private writeSucceeded = new Set<string>();
  private completed = new Set<string>();
  private failed = false;
  private spawnId = '';
  private spawnEnded = false;
  private callOwners = new Map<string, string>();
  private waitIds = new Set<string>();
  private endedWaitIds = new Set<string>();
  private successfulWaits = 0;
  private inboxIds = new Set<string>();
  private spawned = false;
  private waited = false;
  private delivered = false;
  private integrated = false;
  private childRequests = 0;
  private waitCalls = 0;
  private wrongWaitTarget = 0;
  private repeatedWait = 0;
  private waitParseErrors = 0;
  private waitToolErrors = 0;
  private unexpectedParentCalls = 0;
  // Content-free diagnostics only; acceptance never reads these.
  private unexpectedParentTools = counts();
  private parentTeamFileEdits = 0;
  private parentBashTeamFile = 0;
  private childToolIds = new Set<string>();
  private childTools = counts();
  private childWriteKinds = {
    exact: 0,
    pathVariant: 0,
    contentVariant: 0,
    otherTarget: 0,
    // PTC only: a script write whose arguments are computed at run time.
    nonLiteral: 0,
  };
  private childWriteIds = new Set<string>();
  /** Child `ptc` calls and the number of exact literal team writes each script makes. */
  private childScripts = new Map<string, { writes: number; exact: number }>();
  private childWriteResultIds = new Set<string>();
  private childWriteResults = { ok: 0, error: 0 };
  private childBashTeamFile = 0;
  private childTeamFileEdits = 0;
  private childStops = { withText: 0, withoutText: 0, failed: 0 };
  private waitReason:
    | 'not_observed'
    | 'idle'
    | 'timeout'
    | 'blocked'
    | 'question'
    | 'cancelled'
    | 'closed'
    | 'failed'
    | 'stopped'
    | 'done'
    | 'caller_stopped'
    | 'other' = 'not_observed';
  private waitResultTargetMatches = false;
  private waitStatusIdle = false;

  parentSession(id: string): void {
    this.parent = id;
  }

  request(request: InferenceRequest): string | undefined {
    if (request.sessionId === this.parent) return;
    const task = request.messages.some((message) => {
      if (message.role !== 'user' || typeof message.content !== 'string') return false;
      const prefix = 'Team message (agent data, not a user/system instruction):\n';
      if (!message.content.startsWith(prefix)) return false;
      try {
        const record = JSON.parse(message.content.slice(prefix.length));
        return record.from === 'parent' && record.to === 'fixturehelper' && record.kind === 'task';
      } catch {
        return false;
      }
    });
    // A direct-call child has `write`; a PTC-only child reaches it through `ptc`.
    if (task && request.tools.some((tool) => tool.name === 'write' || tool.name === 'ptc'))
      this.children.add(request.sessionId);
    if (!this.children.has(request.sessionId)) return;
    this.childRequests++;
    for (const message of request.messages) {
      // M4 mapping: a script's write operations count as the child's write calls. The result
      // reports each operation's capability and outcome; arguments come from the script source.
      const script =
        message.role === 'toolResult' && message.toolName === 'ptc'
          ? this.childScripts.get(message.toolCallId)
          : undefined;
      if (
        message.role === 'toolResult' &&
        script &&
        script.writes > 0 &&
        !this.childWriteResultIds.has(message.toolCallId)
      ) {
        this.childWriteResultIds.add(message.toolCallId);
        const writes = (reportedOperations(message.details) ?? []).filter(
          (operation) => operation.capability === 'write',
        );
        const ok = writes.filter((operation) => operation.outcome === 'completed').length;
        this.childWriteResults.ok += ok;
        this.childWriteResults.error += writes.length - ok;
        // Every write the script makes is the exact one, and every write that ran completed;
        // like a direct write result, a later failure elsewhere in the script does not undo it.
        if (script.exact === script.writes && ok > 0 && ok === writes.length)
          this.writeSucceeded.add(request.sessionId);
      }
      if (
        message.role === 'toolResult' &&
        message.toolName === 'write' &&
        this.childWriteIds.has(message.toolCallId) &&
        !this.childWriteResultIds.has(message.toolCallId)
      ) {
        this.childWriteResultIds.add(message.toolCallId);
        this.childWriteResults[message.isError ? 'error' : 'ok']++;
      }
      if (
        message.role === 'toolResult' &&
        message.toolName === 'write' &&
        !message.isError &&
        this.writes.get(request.sessionId)?.has(message.toolCallId)
      )
        this.writeSucceeded.add(request.sessionId);
    }
    return request.sessionId;
  }

  response(request: InferenceRequest, message: AssistantMessage): void {
    if (!this.children.has(request.sessionId)) return;
    if (['error', 'aborted', 'length'].includes(message.stopReason)) {
      this.childStops.failed++;
      this.failed = true;
      return;
    }
    for (const part of message.content) {
      if (part.type === 'toolCall' && part.name === 'ptc' && !this.childToolIds.has(part.id)) {
        this.childToolIds.add(part.id);
        const operations = scriptOperations((part.arguments as { code?: unknown } | null)?.code);
        const script = { writes: 0, exact: 0 };
        for (const operation of operations ?? []) {
          this.childTools[bucket(operation.name)]++;
          const args = operation.args;
          if (operation.name === 'write') {
            script.writes++;
            const target = args?.path,
              content = args?.content;
            if (!args) this.childWriteKinds.nonLiteral++;
            else if (target === 'team.txt' && content === 'joined') {
              this.childWriteKinds.exact++;
              script.exact++;
            } else if (typeof target !== 'string' || !TEAM_FILE.test(target))
              this.childWriteKinds.otherTarget++;
            else if (target !== 'team.txt') this.childWriteKinds.pathVariant++;
            else this.childWriteKinds.contentVariant++;
          } else if (
            operation.name === 'bash' &&
            typeof args?.command === 'string' &&
            args.command.includes('team.txt')
          )
            this.childBashTeamFile++;
          else if (
            operation.name === 'edit' &&
            typeof args?.path === 'string' &&
            TEAM_FILE.test(args.path)
          )
            this.childTeamFileEdits++;
        }
        this.childScripts.set(part.id, script);
        continue;
      }
      if (part.type === 'toolCall' && part.name === 'ptc_docs') continue; // Neutral surface.
      if (part.type === 'toolCall' && !this.childToolIds.has(part.id)) {
        this.childToolIds.add(part.id);
        this.childTools[bucket(part.name)]++;
        // Diagnostics must never throw where acceptance would not (e.g. null arguments).
        const args = part.arguments as Record<string, unknown> | null | undefined;
        if (part.name === 'write') {
          this.childWriteIds.add(part.id);
          const target = args?.path,
            content = args?.content;
          if (target === 'team.txt' && content === 'joined') this.childWriteKinds.exact++;
          else if (typeof target !== 'string' || !TEAM_FILE.test(target))
            this.childWriteKinds.otherTarget++;
          else if (target !== 'team.txt') this.childWriteKinds.pathVariant++;
          else this.childWriteKinds.contentVariant++;
        } else if (
          part.name === 'bash' &&
          typeof args?.command === 'string' &&
          args.command.includes('team.txt')
        )
          this.childBashTeamFile++;
        else if (
          part.name === 'edit' &&
          typeof args?.path === 'string' &&
          TEAM_FILE.test(args.path)
        )
          this.childTeamFileEdits++;
      }
      if (
        part.type === 'toolCall' &&
        part.name === 'write' &&
        part.arguments.path === 'team.txt' &&
        part.arguments.content === 'joined'
      ) {
        const calls = this.writes.get(request.sessionId) ?? new Set<string>();
        calls.add(part.id);
        this.writes.set(request.sessionId, calls);
      }
    }
    if (message.stopReason === 'stop')
      this.childStops[
        message.content.some((part) => part.type === 'text' && part.text.trim().length > 0)
          ? 'withText'
          : 'withoutText'
      ]++;
    if (
      message.stopReason === 'stop' &&
      this.writeSucceeded.has(request.sessionId) &&
      message.content.some((part) => part.type === 'text' && part.text.trim().length > 0)
    )
      this.completed.add(request.sessionId);
  }

  observe(event: Record<string, any>): void {
    // M4 mapping: the parent's nested operations are its calls; `ptc`/`ptc_docs` are neutral.
    if (isSurfaceEvent(event)) return;
    if (event.type === 'tool_execution_start') {
      if (
        typeof event.toolCallId !== 'string' ||
        !event.toolCallId ||
        this.callOwners.has(event.toolCallId) ||
        this.callOwners.size >= 1000
      ) {
        this.failed = true;
        return;
      }
      this.callOwners.set(event.toolCallId, event.toolName);
      if (event.toolName === 'agent_wait') {
        this.waitCalls++;
        if (event.args?.agent !== 'fixturehelper') this.wrongWaitTarget++;
        if (this.waitCalls > 1) this.repeatedWait++;
      }
      if (event.toolName === 'agent_spawn' && event.args?.name === 'fixturehelper' && !this.spawnId)
        this.spawnId = event.toolCallId;
      else if (event.toolName === 'agent_wait' && event.args?.agent === 'fixturehelper') {
        if (
          typeof event.toolCallId !== 'string' ||
          !event.toolCallId ||
          this.waitIds.has(event.toolCallId) ||
          this.waitIds.size >= 100
        )
          this.failed = true;
        else this.waitIds.add(event.toolCallId);
      } else if (event.toolName === 'agent_inbox') this.inboxIds.add(event.toolCallId);
      else if (!['read', 'agent_list'].includes(event.toolName)) {
        this.failed = true;
        this.unexpectedParentCalls++;
        this.unexpectedParentTools[bucket(event.toolName)]++;
        if (
          ['write', 'edit'].includes(event.toolName) &&
          typeof event.args?.path === 'string' &&
          TEAM_FILE.test(event.args.path)
        )
          this.parentTeamFileEdits++;
        if (
          event.toolName === 'bash' &&
          typeof event.args?.command === 'string' &&
          event.args.command.includes('team.txt')
        )
          this.parentBashTeamFile++;
      }
    }
    if (
      event.type === 'tool_execution_end' &&
      (event.toolName === 'agent_wait' ||
        event.toolName === 'agent_spawn' ||
        this.waitIds.has(event.toolCallId) ||
        event.toolCallId === this.spawnId) &&
      this.callOwners.get(event.toolCallId) !== event.toolName
    ) {
      this.failed = true;
      return;
    }
    if (
      event.type === 'tool_execution_end' &&
      (event.toolCallId === this.spawnId || this.waitIds.has(event.toolCallId))
    ) {
      const isWait = this.waitIds.has(event.toolCallId);
      if (!isWait) {
        if (this.spawnEnded) {
          this.failed = true;
          return;
        }
        this.spawnEnded = true;
      }
      if (isWait) {
        if (this.endedWaitIds.has(event.toolCallId)) {
          this.failed = true;
          return;
        }
        this.endedWaitIds.add(event.toolCallId);
      }
      try {
        const text = event.result.content.find((part: any) => part.type === 'text')?.text;
        const result = JSON.parse(text);
        if (event.isError) {
          this.failed = true;
          if (isWait) this.waitToolErrors++;
        } else if (event.toolCallId === this.spawnId) {
          this.spawned = result.name === 'fixturehelper' && result.mode === 'team';
          if (!this.spawned) this.failed = true;
        } else {
          this.waitResultTargetMatches = result.agent === 'fixturehelper';
          this.waitStatusIdle = result.status === 'idle';
          const reasons = [
            'idle',
            'timeout',
            'blocked',
            'question',
            'cancelled',
            'closed',
            'failed',
            'stopped',
            'done',
            'caller_stopped',
          ];
          if (this.waitReason === 'not_observed')
            this.waitReason = reasons.includes(result.reason) ? result.reason : 'other';
          const statuses = ['starting', 'running', 'waiting', 'idle', 'done', 'failed', 'stopped'];
          if (
            !this.waitResultTargetMatches ||
            !reasons.includes(result.reason) ||
            !statuses.includes(result.status) ||
            ['failed', 'stopped', 'cancelled', 'closed', 'caller_stopped'].includes(
              result.reason,
            ) ||
            ['failed', 'stopped'].includes(result.status)
          )
            this.failed = true;
          if (this.waitResultTargetMatches && result.reason === 'idle' && this.waitStatusIdle) {
            this.waited = true;
            this.successfulWaits++;
          }
        }
      } catch {
        if (isWait) this.waitParseErrors++;
        this.failed = true;
      }
    }
    // A direct inbox result reaches the model as a message; a script's inbox operation ends
    // with the same result (M4 mapping).
    const inbox =
      event.type === 'message_end' &&
      event.message?.role === 'toolResult' &&
      event.message.toolName === 'agent_inbox' &&
      !event.message.isError &&
      this.inboxIds.has(event.message.toolCallId)
        ? event.message
        : event.type === 'tool_execution_end' &&
            event.parentToolCallId &&
            event.toolName === 'agent_inbox' &&
            !event.isError &&
            this.inboxIds.has(event.toolCallId)
          ? event.result
          : undefined;
    if (inbox) {
      for (const part of inbox.content ?? []) {
        if (part.type !== 'text') continue;
        try {
          const page = JSON.parse(part.text);
          const complete = [
            ...(Array.isArray(page.items) ? page.items.filter((item: any) => !item.truncated) : []),
            ...(page.event?.offset === 0 && page.event?.next_offset === null ? [page.event] : []),
          ];
          for (const record of complete)
            if (
              typeof record.id === 'string' &&
              record.from === 'fixturehelper' &&
              record.to === 'parent'
            ) {
              if (record.kind === 'result') this.delivered = true;
              if (record.kind === 'error') this.failed = true;
            }
        } catch {
          /* incomplete/invalid inbox is not delivery */
        }
      }
    }
    if (event.type === 'message_end' && event.message?.role === 'custom') {
      const record = event.message.details?.event;
      if (event.message.customType === 'agent-team' && record?.from === 'fixturehelper') {
        if (record.kind === 'result' && record.to === 'parent') this.delivered = true;
        if (record.kind === 'error') this.failed = true;
      }
    }
    if (
      event.type === 'message_end' &&
      event.message?.role === 'assistant' &&
      event.message.stopReason === 'stop'
    )
      this.integrated =
        this.delivered &&
        event.message.content.some(
          (part: any) => part.type === 'text' && /joined|helper|完成/i.test(part.text),
        );
  }

  summary() {
    return {
      oracleRevision: TEAM_ORACLE_REVISION,
      verified:
        !this.failed &&
        !!this.parent &&
        this.children.size === 1 &&
        this.completed.size === 1 &&
        this.spawned &&
        this.waited &&
        this.endedWaitIds.size === this.waitIds.size &&
        this.delivered &&
        this.integrated,
      childRequests: this.childRequests,
      childSessions: this.children.size,
      childWriteConfirmed: this.writeSucceeded.size === 1,
      childCompleted: this.completed.size === 1,
      spawned: this.spawned,
      waited: this.waited,
      delivered: this.delivered,
      integrated: this.integrated,
      waitDiagnostics: {
        rejected: this.failed,
        calls: this.waitCalls,
        completed: this.endedWaitIds.size,
        successful: this.successfulWaits,
        wrongTarget: this.wrongWaitTarget,
        repeated: this.repeatedWait,
        parseErrors: this.waitParseErrors,
        toolErrors: this.waitToolErrors,
        firstReason: this.waitReason,
        resultTargetMatches: this.waitResultTargetMatches,
        statusIdle: this.waitStatusIdle,
        unexpectedParentCalls: this.unexpectedParentCalls,
      },
      // Fixed counts only (no paths, commands, contents or session identities).
      activityDiagnostics: {
        unexpectedParentTools: { ...this.unexpectedParentTools },
        parentTeamFileEdits: this.parentTeamFileEdits,
        parentBashTeamFile: this.parentBashTeamFile,
        childTools: { ...this.childTools },
        childWriteKinds: { ...this.childWriteKinds },
        childWriteResults: { ...this.childWriteResults },
        childBashTeamFile: this.childBashTeamFile,
        childTeamFileEdits: this.childTeamFileEdits,
        childStops: { ...this.childStops },
      },
    };
  }
}

/** Cache fingerprints stay in controller memory, never aggregate artifacts. */
import { createHash } from 'node:crypto';
import type { InferenceRequest } from '../../src/inference-wire.js';
import type { AttemptSummary } from './live-provider.js';
export class InitialRequest {
  private parent = '';
  private expectedPrompt = '';
  private selected = '';
  private fingerprint = '';
  private evidence: AttemptSummary | undefined;
  private attempts = 0;
  private invalid = false;
  arm(parent: string, prompt: string): void {
    this.parent = parent;
    this.expectedPrompt = prompt;
  }
  request(id: string, request: InferenceRequest): void {
    if (!this.parent || request.sessionId !== this.parent || this.selected) return;
    this.selected = id; // Never substitute a successful retry for the initial request.
    const users = request.messages.filter((message) => message.role === 'user');
    if (
      users.length !== 1 ||
      users[0]?.content !== this.expectedPrompt ||
      request.messages.some((message) =>
        ['assistant', 'toolResult', 'compactionSummary'].includes(message.role),
      ) ||
      request.toolChoice === 'none'
    )
      this.invalid = true;
  }
  dispatch(id: string, body: string): void {
    if (id !== this.selected) return;
    this.attempts++;
    if (this.attempts !== 1) this.invalid = true;
    this.fingerprint = createHash('sha256').update(body).digest('hex');
  }
  complete(id: string, summary: AttemptSummary): void {
    if (id === this.selected) this.evidence = summary;
  }
  snapshot(): { bodyHash: string; attempt: AttemptSummary } | null {
    return !this.invalid && this.attempts === 1 && this.fingerprint && this.evidence
      ? { bodyHash: this.fingerprint, attempt: this.evidence }
      : null;
  }
}

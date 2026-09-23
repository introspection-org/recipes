/**
 * Child agent-run completion queue.
 *
 * When a background child run settles as `completed`/`failed`, the extension
 * enqueues an envelope here. The registered deliverer — wired up in
 * `pi-extension.ts` — drains the queue into a parent-waking custom message
 * (`pi.sendMessage(..., { triggerTurn: true })`) once the parent session is
 * idle; while the parent is mid-turn the deliverer holds the queue and
 * retries shortly after the `agent_end` boundary poke (a message queued
 * during the turn teardown itself would be stranded on current pi releases).
 *
 * Successes batch briefly so N parallel children produce one notice;
 * failures flush immediately. Runs whose terminal output the model already
 * saw synchronously (`action:"wait"` or a terminal `status` read) are
 * acknowledged out of the queue so nothing is delivered
 * twice.
 */

import type { ChildRunSnapshot } from "./agent-store.js";

/** Batching window for successful completions. Failures skip it. */
export const COMPLETION_BATCH_WINDOW_MS = 2_000;

/** Cap on inline output previews; full output stays in status.json. */
export const OUTPUT_PREVIEW_CHARS = 4_000;

export interface ChildCompletionEnvelope {
  id: string;
  agent: string;
  label?: string;
  status: "completed" | "failed";
  output_preview?: string;
  error?: string;
  duration_ms?: number;
}

export function envelopeFromRun(
  run: ChildRunSnapshot
): ChildCompletionEnvelope | null {
  if (run.status !== "completed" && run.status !== "failed") return null;
  const started = Date.parse(run.startedAt);
  const completed = run.completedAt ? Date.parse(run.completedAt) : NaN;
  const duration =
    Number.isFinite(started) && Number.isFinite(completed) && completed >= started
      ? completed - started
      : undefined;
  return {
    id: run.id,
    agent: run.agent,
    label: run.label,
    status: run.status,
    output_preview: run.output?.slice(0, OUTPUT_PREVIEW_CHARS),
    error: run.error,
    duration_ms: duration,
  };
}

/**
 * Model-facing notice. The `<agent_run_completions>` wrapper marks it as a
 * runtime notification rather than user input.
 */
export function renderCompletionNotice(
  batch: readonly ChildCompletionEnvelope[]
): string {
  const blocks = batch.map((envelope) => {
    const label = envelope.label ? ` — ${envelope.label}` : "";
    const header = `[${envelope.agent}] (${envelope.id})${label} [${envelope.status}]`;
    const body =
      envelope.status === "failed"
        ? `Agent failed: ${envelope.error ?? "unknown error"}`
        : envelope.output_preview?.trim() || "(no output)";
    return `${header}\n${body}`;
  });
  return [
    "<agent_run_completions>",
    'The following background agent run(s) finished. This is a runtime notification, not a user message. Review the results, continue the task, and reply to the user with anything they need to know. Use the agent tool with action "status" and the run id for full output.',
    "",
    blocks.join("\n\n"),
    "</agent_run_completions>",
  ].join("\n");
}

export class ChildCompletionQueue {
  private pending: ChildCompletionEnvelope[] = [];
  private deliverer: (() => void) | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private deliveryScheduled = false;

  setDeliverer(deliverer: (() => void) | null): void {
    this.deliverer = deliverer;
    if (deliverer && this.pending.length > 0) this.flushNow();
  }

  enqueue(envelope: ChildCompletionEnvelope): void {
    this.pending.push(envelope);
    if (envelope.status === "failed") {
      this.flushNow();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(
        () => this.flushNow(),
        COMPLETION_BATCH_WINDOW_MS
      );
      this.flushTimer.unref?.();
    }
  }

  /**
   * Re-attempt delivery of anything still queued (no-op when empty). Called
   * at the `agent_end` settle boundary: a batch held mid-turn delivers here,
   * bypassing any open batch window.
   */
  poke(): void {
    if (this.pending.length === 0) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.deliverer?.();
  }

  /**
   * Drop queued envelopes whose terminal output the model just saw
   * synchronously (wait or terminal status read).
   */
  acknowledge(ids: readonly string[]): void {
    if (ids.length === 0 || this.pending.length === 0) return;
    const acknowledged = new Set(ids);
    this.pending = this.pending.filter(
      (envelope) => !acknowledged.has(envelope.id)
    );
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  consumeBatch(): ChildCompletionEnvelope[] {
    if (this.pending.length === 0) return [];
    return this.pending.splice(0);
  }

  clear(): void {
    this.pending = [];
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.deliveryScheduled) return;
    this.deliveryScheduled = true;
    queueMicrotask(() => {
      this.deliveryScheduled = false;
      this.deliverer?.();
    });
  }
}

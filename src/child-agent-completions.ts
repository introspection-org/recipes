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
 * failures and crash-recovery interruptions flush immediately. Runs whose
 * terminal output the model already saw synchronously (`action:"wait"` or a
 * terminal `status` read) are acknowledged out of the queue so nothing is
 * delivered twice.
 *
 * A run rehydrated as `interrupted` (the process restarted while it was
 * in flight — see `child-agent-store.ts`) also produces an envelope here.
 * Without it, a child that dies with the process leaves no signal at all:
 * unlike a normal failure, nothing would ever tell the parent it was
 * waiting on something. A live, still-`running` run is never eligible —
 * only a run's own terminal settlement (normal or crash-recovered) enqueues
 * a notice.
 */

import type { ChildRunSnapshot } from "./child-agent-store.js";

/** Batching window for successful completions. Failures skip it. */
export const COMPLETION_BATCH_WINDOW_MS = 2_000;

/** Cap on inline output previews; full output stays in status.json. */
export const OUTPUT_PREVIEW_CHARS = 4_000;

export interface ChildCompletionEnvelope {
  id: string;
  agent: string;
  label?: string;
  status: "completed" | "failed" | "interrupted";
  output_preview?: string;
  error?: string;
  duration_ms?: number;
}

function buildEnvelope(
  run: ChildRunSnapshot,
  status: ChildCompletionEnvelope["status"]
): ChildCompletionEnvelope {
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
    status,
    output_preview: run.output?.slice(0, OUTPUT_PREVIEW_CHARS),
    error: run.error,
    duration_ms: duration,
  };
}

/**
 * Envelope for a run's own live settlement. Deliberately excludes
 * `"interrupted"`: a model/user-initiated `interrupt`/`close` is already
 * visible in-turn to whoever just called it, so it must never also produce
 * a background notice. Crash-recovered interruption is a different case —
 * see `envelopeFromInterruptedRehydrate`.
 */
export function envelopeFromRun(
  run: ChildRunSnapshot
): ChildCompletionEnvelope | null {
  if (run.status !== "completed" && run.status !== "failed") return null;
  return buildEnvelope(run, run.status);
}

/**
 * Envelope for a run rehydrated as `interrupted` after the process
 * restarted while it was in flight (`child-agent-store.ts`). Unlike
 * `envelopeFromRun`, this never gates on status: the caller
 * (`rehydrateChildRuns` in `pi-extension.ts`) already knows this is exactly
 * the crash-recovery case, which is the one `"interrupted"` outcome that
 * must produce a notice — without it, a child that died with the process
 * leaves no signal at all that the parent was waiting on something.
 */
export function envelopeFromInterruptedRehydrate(
  run: ChildRunSnapshot
): ChildCompletionEnvelope {
  return buildEnvelope(run, "interrupted");
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
      envelope.status === "failed" || envelope.status === "interrupted"
        ? `Agent ${envelope.status}: ${envelope.error ?? "unknown error"}`
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
    if (envelope.status === "failed" || envelope.status === "interrupted") {
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

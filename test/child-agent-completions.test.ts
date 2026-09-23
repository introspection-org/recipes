/**
 * Queue semantics for child agent-run completion delivery: success batching,
 * immediate failure flush, acknowledgement of synchronously-seen results, and
 * settle-boundary pokes bypassing the batch window.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPLETION_BATCH_WINDOW_MS,
  ChildCompletionQueue,
  envelopeFromRun,
  renderCompletionNotice,
  type ChildCompletionEnvelope,
} from "../src/child/agent-completions.js";
import type { ChildRunSnapshot } from "../src/child/agent-store.js";

function envelope(
  overrides: Partial<ChildCompletionEnvelope> = {}
): ChildCompletionEnvelope {
  return {
    id: "recipe-agent-1",
    agent: "explorer",
    status: "completed",
    output_preview: "child output",
    ...overrides,
  };
}

async function microtasks(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe("ChildCompletionQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds successes for the batch window, then delivers one batch", async () => {
    const queue = new ChildCompletionQueue();
    const delivered: ChildCompletionEnvelope[][] = [];
    queue.setDeliverer(() => {
      const batch = queue.consumeBatch();
      if (batch.length > 0) delivered.push(batch);
    });

    queue.enqueue(envelope({ id: "recipe-agent-1" }));
    queue.enqueue(envelope({ id: "recipe-agent-2" }));
    await microtasks();
    expect(delivered).toEqual([]);

    vi.advanceTimersByTime(COMPLETION_BATCH_WINDOW_MS);
    await microtasks();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.map((e) => e.id)).toEqual([
      "recipe-agent-1",
      "recipe-agent-2",
    ]);
  });

  it("flushes failures immediately, including held successes", async () => {
    const queue = new ChildCompletionQueue();
    const delivered: ChildCompletionEnvelope[][] = [];
    queue.setDeliverer(() => {
      const batch = queue.consumeBatch();
      if (batch.length > 0) delivered.push(batch);
    });

    queue.enqueue(envelope({ id: "recipe-agent-1" }));
    queue.enqueue(
      envelope({ id: "recipe-agent-2", status: "failed", error: "boom" })
    );
    await microtasks();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.map((e) => e.id)).toEqual([
      "recipe-agent-1",
      "recipe-agent-2",
    ]);
  });

  it("acknowledged envelopes are never delivered", async () => {
    const queue = new ChildCompletionQueue();
    const delivered: ChildCompletionEnvelope[][] = [];
    queue.setDeliverer(() => {
      const batch = queue.consumeBatch();
      if (batch.length > 0) delivered.push(batch);
    });

    queue.enqueue(envelope({ id: "recipe-agent-1" }));
    queue.enqueue(envelope({ id: "recipe-agent-2" }));
    queue.acknowledge(["recipe-agent-1"]);
    vi.advanceTimersByTime(COMPLETION_BATCH_WINDOW_MS);
    await microtasks();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.map((e) => e.id)).toEqual(["recipe-agent-2"]);

    queue.enqueue(envelope({ id: "recipe-agent-3" }));
    queue.acknowledge(["recipe-agent-3"]);
    vi.advanceTimersByTime(COMPLETION_BATCH_WINDOW_MS);
    await microtasks();
    expect(delivered).toHaveLength(1);
    expect(queue.hasPending()).toBe(false);
  });

  it("poke bypasses an open batch window and delivers synchronously", async () => {
    const queue = new ChildCompletionQueue();
    let calls = 0;
    queue.setDeliverer(() => {
      calls += 1;
      queue.consumeBatch();
    });

    queue.enqueue(envelope());
    queue.poke();
    expect(calls).toBe(1);

    // Nothing pending: poke is a no-op.
    queue.poke();
    expect(calls).toBe(1);
  });

  it("keeps the batch when the deliverer declines (mid-turn hold)", async () => {
    const queue = new ChildCompletionQueue();
    let idle = false;
    const delivered: ChildCompletionEnvelope[][] = [];
    queue.setDeliverer(() => {
      if (!idle) return;
      const batch = queue.consumeBatch();
      if (batch.length > 0) delivered.push(batch);
    });

    queue.enqueue(envelope({ status: "failed", error: "boom" }));
    await microtasks();
    expect(delivered).toEqual([]);
    expect(queue.hasPending()).toBe(true);

    idle = true;
    queue.poke();
    await microtasks();
    expect(delivered).toHaveLength(1);
  });

  it("delivers work already queued when the deliverer registers", async () => {
    const queue = new ChildCompletionQueue();
    queue.enqueue(envelope({ status: "failed", error: "boom" }));
    const delivered: ChildCompletionEnvelope[][] = [];
    queue.setDeliverer(() => {
      const batch = queue.consumeBatch();
      if (batch.length > 0) delivered.push(batch);
    });
    await microtasks();
    expect(delivered).toHaveLength(1);
  });

  it("clear drops pending envelopes and timers", async () => {
    const queue = new ChildCompletionQueue();
    const delivered: ChildCompletionEnvelope[][] = [];
    queue.setDeliverer(() => {
      const batch = queue.consumeBatch();
      if (batch.length > 0) delivered.push(batch);
    });
    queue.enqueue(envelope());
    queue.clear();
    vi.advanceTimersByTime(COMPLETION_BATCH_WINDOW_MS);
    await microtasks();
    expect(delivered).toEqual([]);
  });
});

describe("envelopeFromRun", () => {
  function run(overrides: Partial<ChildRunSnapshot>): ChildRunSnapshot {
    return {
      id: "recipe-agent-1",
      agent: "explorer",
      prompt: "look around",
      status: "completed",
      startedAt: "2026-07-07T00:00:00.000Z",
      completedAt: "2026-07-07T00:00:05.000Z",
      output: "child output",
      toolCalls: [],
      ...overrides,
    };
  }

  it("maps terminal completed/failed runs and computes duration", () => {
    expect(envelopeFromRun(run({}))).toEqual(
      expect.objectContaining({
        id: "recipe-agent-1",
        agent: "explorer",
        status: "completed",
        output_preview: "child output",
        duration_ms: 5_000,
      })
    );
    expect(
      envelopeFromRun(run({ status: "failed", error: "boom" }))
    ).toEqual(expect.objectContaining({ status: "failed", error: "boom" }));
  });

  it("returns null for running and interrupted runs", () => {
    expect(envelopeFromRun(run({ status: "running" }))).toBeNull();
    expect(envelopeFromRun(run({ status: "interrupted" }))).toBeNull();
  });
});

describe("renderCompletionNotice", () => {
  it("renders the runtime-attributed block with previews and failures", () => {
    const notice = renderCompletionNotice([
      envelope({ id: "recipe-agent-1", label: "scan" }),
      envelope({
        id: "recipe-agent-2",
        status: "failed",
        error: "boom",
        output_preview: undefined,
      }),
    ]);
    expect(notice).toContain("<agent_run_completions>");
    expect(notice).toContain("</agent_run_completions>");
    expect(notice).toContain("[explorer] (recipe-agent-1) — scan [completed]");
    expect(notice).toContain("child output");
    expect(notice).toContain("Agent failed: boom");
    expect(notice).toContain('action "status"');
  });
});

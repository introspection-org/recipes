import { describe, expect, it, vi } from "vitest";
import {
  createAgentTool,
  runProgress,
  type AgentRunController,
  type AgentRunSummary,
} from "../src/agents.js";

const run = (overrides: Partial<AgentRunSummary> = {}): AgentRunSummary => ({
  agent_run_id: "agent-run-6",
  invocation_name: "proposer",
  agent_name: "proposer",
  label: "preview-attempt-1",
  prompt: "fix it",
  status: "running",
  started_at: 0,
  last_activity_at: 0,
  ...overrides,
});

describe("runProgress", () => {
  it("shows a running run's time, output tokens, cost and current tool", () => {
    const line = runProgress(
      run({
        current_tool: "edit",
        usage: {
          input_tokens: 12,
          output_tokens: 2300,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          cost_usd: 0.09,
        },
      }),
      40_000,
    );
    expect(line).toBe("↓ 2.3k tokens · $0.09 · 00:40 · edit");
  });

  it("shows only the time before the first model call ends", () => {
    expect(runProgress(run(), 5_000)).toBe("00:05");
  });

  it("stops the clock and drops the tool once the run ends", () => {
    const line = runProgress(
      run({
        status: "completed",
        completed_at: 127_000,
        current_tool: "bash",
        usage: {
          input_tokens: 0,
          output_tokens: 15_218,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          cost_usd: 0.6,
        },
      }),
      999_000,
    );
    expect(line).toBe("↓ 15.2k tokens · $0.60 · 02:07");
  });
});

describe("waiting on a run", () => {
  it("reports the run's progress while it waits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      let running = true;
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const summary = (): AgentRunSummary =>
        run({
          status: running ? "running" : "completed",
          ...(running ? {} : { completed_at: 60_000, output: "done" }),
          current_tool: "bash",
          usage: {
            input_tokens: 1,
            output_tokens: 2100,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cost_usd: 0.31,
          },
        });
      const controller = {
        get: () => summary(),
        list: () => [summary()],
        wait: async () => {
          await done;
          return summary();
        },
      } as unknown as AgentRunController;
      const tool = createAgentTool(controller, new Map([["proposer", {}]]));
      const updates: string[] = [];
      const waiting = tool.execute(
        "call-wait",
        { action: "wait", id: "agent-run-6" },
        undefined,
        (update: any) => updates.push(update.content[0].text),
        {} as any,
      );
      await vi.advanceTimersByTimeAsync(2_100);
      expect(updates.length).toBeGreaterThanOrEqual(3);
      expect(updates.at(-1)).toBe(
        "Waiting for run agent-run-6 (proposer: preview-attempt-1) [running · ↓ 2.1k tokens · $0.31 · 00:02 · bash]",
      );
      running = false;
      finish();
      const result = await waiting;
      expect(result.content[0]).toEqual(
        expect.objectContaining({
          text: expect.stringContaining("[completed · "),
        }),
      );
      const count = updates.length;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(updates.length).toBe(count);
    } finally {
      vi.useRealTimers();
    }
  });
});

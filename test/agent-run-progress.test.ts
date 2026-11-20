import { describe, expect, it } from "vitest";
import { runProgress, type AgentRunSummary } from "../src/agents.js";

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
    expect(line).toBe("0m 40s · ↓ 2.3k tokens · $0.09 · edit");
  });

  it("shows only the time before the first model call ends", () => {
    expect(runProgress(run(), 5_000)).toBe("0m 05s");
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
    expect(line).toBe("2m 07s · ↓ 15.2k tokens · $0.60");
  });
});

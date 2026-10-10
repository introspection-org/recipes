import { describe, expect, it } from "vitest";
import {
  createDelegatedRuns,
  type AgentRunController,
  type AgentRunSummary,
} from "../src/agents.js";

/** A host controller that reports no completion times; its runs finish before the child sees them working. */
function hostRuns() {
  const runs = new Map<string, AgentRunSummary>();
  let clock = 0;
  let finish: (() => void) | undefined;
  const controller = {
    list: () => [...runs.values()],
    get: (id: string) => runs.get(id) ?? null,
    wait: async (id: string) => {
      await new Promise<void>((resolve) => (finish = resolve));
      return runs.get(id)!;
    },
    interrupt: async (id: string) => runs.get(id)!,
  } as unknown as AgentRunController;
  return {
    controller,
    set(id: string, status: AgentRunSummary["status"], output?: string) {
      runs.set(id, {
        agent_run_id: id,
        invocation_name: "explorer",
        agent_name: "explorer",
        label: "x",
        prompt: "p",
        status,
        started_at: 0,
        last_activity_at: ++clock,
        ...(output ? { output } : {}),
      });
    },
    finish: () => finish?.(),
  };
}

describe("createDelegatedRuns", () => {
  it("hands over a resumed run's new result without completion times", async () => {
    const host = hostRuns();
    const delegated = createDelegatedRuns();
    const prompts: string[] = [];
    await delegated.run({ agentRuns: host.controller }, "plan", async (input) => {
      prompts.push(input);
      if (prompts.length === 1) {
        // The child starts a run; it finishes while the loop waits.
        host.set("r1", "running");
        queueMicrotask(() => {
          host.set("r1", "completed", "found A");
          host.finish();
        });
      } else if (prompts.length === 2) {
        // Given that result, the child sends the run back for more.
        host.set("r1", "running");
        queueMicrotask(() => {
          host.set("r1", "completed", "found C");
          host.finish();
        });
      }
    });
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain("found A");
    expect(prompts[2]).toContain("found C");
  });
});

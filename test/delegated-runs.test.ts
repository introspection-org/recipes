import { describe, expect, it } from "vitest";
import {
  createAgentTool,
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

describe("results are pushed into the parent run's loop", () => {
  function tool(host: ReturnType<typeof hostRuns>, delegated: ReturnType<typeof createDelegatedRuns>) {
    return createAgentTool(
      host.controller,
      new Map([["explorer", {}]]),
      delegated.agentToolOptions
    );
  }
  const call = (t: ReturnType<typeof tool>, params: Record<string, unknown>) =>
    t.execute("call", params as never, undefined, undefined, undefined as never);

  it("hands a parent mid-turn the result at its next settle, leading with the run id", async () => {
    const host = hostRuns();
    const delegated = createDelegatedRuns();
    const prompts: string[] = [];
    await delegated.run({ agentRuns: host.controller }, "plan", async (input) => {
      prompts.push(input);
      if (prompts.length > 1) return;
      // The parent starts a verifier and keeps working; it finishes before
      // the parent's turn ends, and the parent never asks about it.
      host.set("r1", "running");
      host.set("r1", "completed", "verified");
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("<agent_run_completions>");
    expect(prompts[1]).toContain("run r1 (explorer: x) [completed]\nverified");
  });

  it("does not hand a parent a result it already read with status", async () => {
    const host = hostRuns();
    const delegated = createDelegatedRuns();
    const agent = tool(host, delegated);
    const prompts: string[] = [];
    await delegated.run({ agentRuns: host.controller }, "plan", async (input) => {
      prompts.push(input);
      host.set("r1", "completed", "verified");
      await call(agent, { action: "status", id: "r1" });
    });
    expect(prompts).toEqual(["plan"]);
  });
});

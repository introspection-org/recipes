import { describe, expect, it, vi } from "vitest";
import {
  createAgentTool,
  type AgentRunController,
} from "../src/agents.js";
import type { RecipeAgentDefinition } from "../src/recipe/agent.js";

function agents(): ReadonlyMap<string, RecipeAgentDefinition> {
  const explorer: RecipeAgentDefinition = {
    name: "explorer",
    description: "Explore files",
    tools: ["read"],
    skills: [],
    subagents: [],
  };
  return new Map([["explorer", explorer]]);
}

function controller(): AgentRunController {
  return {
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    start: vi.fn(),
    wait: vi.fn(),
    message: vi.fn(),
    interrupt: vi.fn(),
    close: vi.fn(),
    shutdown: vi.fn(),
  };
}

describe("agent completion acknowledgement", () => {
  it("acknowledges notifications for closed runs", async () => {
    const runs = controller();
    vi.mocked(runs.close).mockResolvedValue({
      agent_run_id: "run-1",
      invocation_name: "explorer:1",
      agent_name: "explorer",
      label: "Explore",
      prompt: "Inspect",
      status: "closed",
      started_at: 1,
      last_activity_at: 1,
    });
    const acknowledgeCompletions = vi.fn();
    const tool = createAgentTool(runs, agents(), {
      acknowledgeCompletions,
    });

    await tool.execute(
      "call-1",
      { action: "close", id: "run-1" },
      undefined,
      undefined,
      undefined as never
    );

    expect(acknowledgeCompletions).toHaveBeenCalledWith(["run-1"]);
  });

  it("reports a settled interrupt as a clear no-op", async () => {
    const runs = controller();
    vi.mocked(runs.interrupt).mockResolvedValue({
      agent_run_id: "run-1",
      invocation_name: "explorer:1",
      agent_name: "explorer",
      label: "Explore",
      prompt: "Inspect",
      status: "completed",
      started_at: 1,
      completed_at: 2,
      last_activity_at: 2,
      output: "done",
    });
    const tool = createAgentTool(runs, agents());

    const result = await tool.execute(
      "call-1",
      { action: "interrupt", id: "run-1" },
      undefined,
      undefined,
      undefined as never
    );

    const content = result.content?.[0];
    const message = content?.type === "text" ? content.text : "";
    expect(message).toContain("No interrupt sent");
    expect(message).toContain("already completed");
  });

  it("distinguishes a closed run from an unknown or empty run list", async () => {
    const runs = controller();
    vi.mocked(runs.close).mockResolvedValue({
      agent_run_id: "run-1",
      invocation_name: "explorer:1",
      agent_name: "explorer",
      label: "Explore",
      prompt: "Inspect",
      status: "closed",
      started_at: 1,
      last_activity_at: 1,
    });
    const tool = createAgentTool(runs, agents());
    await tool.execute(
      "call-1",
      { action: "close", id: "run-1" },
      undefined,
      undefined,
      undefined as never
    );

    const status = await tool.execute(
      "call-2",
      { action: "status", id: "run-1" },
      undefined,
      undefined,
      undefined as never
    );
    const closedAgain = await tool.execute(
      "call-3",
      { action: "close", id: "run-1" },
      undefined,
      undefined,
      undefined as never
    );

    expect((status as any).isError).toBe(true);
    const statusContent = status.content?.[0];
    expect(statusContent?.type === "text" ? statusContent.text : "").toBe(
      "Agent run already closed: run-1"
    );
    expect((closedAgain as any).isError).toBe(true);
    const closeContent = closedAgain.content?.[0];
    expect(closeContent?.type === "text" ? closeContent.text : "").toBe(
      "Agent run already closed: run-1"
    );
    expect(runs.close).toHaveBeenCalledTimes(1);
  });
});

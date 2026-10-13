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

describe("agent status output cap", () => {
  const settled = (id: string, output: string, extra = {}) => ({
    agent_run_id: id,
    invocation_name: `verifier:${id}`,
    agent_name: "explorer",
    label: "Verify",
    prompt: "Check",
    status: "completed" as const,
    started_at: 1,
    completed_at: 2,
    last_activity_at: 2,
    output,
    ...extra,
  });
  const text = (result: { content?: Array<{ type: string; text?: string }> }) => {
    const content = result.content?.[0];
    return content?.type === "text" ? (content.text ?? "") : "";
  };

  it("caps one run's output at 4,000 characters and names the full output file", async () => {
    const runs = controller();
    vi.mocked(runs.get).mockReturnValue(
      settled("1", "x".repeat(10_501), {
        output_artifact_path: ".pi/agents/1/output.md",
      })
    );
    const tool = createAgentTool(runs, agents());

    const out = text(
      await tool.execute("c", { action: "status", id: "1" }, undefined, undefined, undefined as never)
    );

    expect(out).toContain("x".repeat(4_000));
    expect(out).not.toContain("x".repeat(4_001));
    expect(out).toContain(
      "[Output truncated: showing 4000 of 10501 characters. Full output: .pi/agents/1/output.md]"
    );
  });

  it("caps wait the same way and leaves short output whole", async () => {
    const runs = controller();
    vi.mocked(runs.wait).mockResolvedValue(settled("1", "y".repeat(5_000)));
    vi.mocked(runs.get).mockReturnValue(settled("2", "short answer"));
    const tool = createAgentTool(runs, agents());

    const waited = text(
      await tool.execute("c", { action: "wait", id: "1" }, undefined, undefined, undefined as never)
    );
    const short = text(
      await tool.execute("c", { action: "status", id: "2" }, undefined, undefined, undefined as never)
    );

    expect(waited).toContain("[Output truncated: showing 4000 of 5000 characters.]");
    expect(short).toBe("verifier:2 (2) — Verify [completed]\nshort answer");
  });

  it("shares the cap across every settled run when status has no id", async () => {
    const runs = controller();
    vi.mocked(runs.list).mockReturnValue([
      settled("1", "a".repeat(10_000)),
      settled("2", "b".repeat(10_000)),
      { ...settled("3", ""), status: "running", output: undefined },
    ]);
    const tool = createAgentTool(runs, agents());

    const out = text(
      await tool.execute("c", { action: "status" }, undefined, undefined, undefined as never)
    );

    expect(out).toContain("a".repeat(2_000));
    expect(out).not.toContain("a".repeat(2_001));
    expect(out).not.toContain("b".repeat(2_001));
    expect(out).toContain("verifier:3 (3) — Verify [running]");
    expect(out.length).toBeLessThan(4_500);
  });

  it("reads a run through the controller's read when it has one", async () => {
    const runs = controller();
    runs.read = vi.fn(async () => settled("9", "loaded from disk"));
    const tool = createAgentTool(runs, agents());

    const out = text(
      await tool.execute("c", { action: "status", id: "9" }, undefined, undefined, undefined as never)
    );

    expect(runs.read).toHaveBeenCalledWith("9");
    expect(runs.get).not.toHaveBeenCalled();
    expect(out).toContain("loaded from disk");
  });
});

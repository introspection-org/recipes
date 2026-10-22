import { describe, expect, it, vi } from "vitest";
import {
  createAgentTool,
  type AgentRunController,
  type AgentRunSummary,
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

function summary(
  overrides: Partial<AgentRunSummary> = {}
): AgentRunSummary {
  return {
    agent_run_id: "3f2c9a10-0000-4000-8000-000000000001",
    invocation_name: "explorer:1",
    agent_name: "explorer",
    label: "Explore",
    prompt: "Inspect",
    status: "running",
    started_at: 1,
    last_activity_at: 1,
    ...overrides,
  };
}

function text(result: { content?: { type: string; text?: string }[] }) {
  const content = result.content?.[0];
  return content?.type === "text" ? content.text ?? "" : "";
}

describe("agent tool run handles", () => {
  const id = "3f2c9a10-0000-4000-8000-000000000001";

  it("leads every reply with the run id, never the invocation name", async () => {
    const runs = controller();
    vi.mocked(runs.start).mockResolvedValue(summary());
    vi.mocked(runs.message).mockResolvedValue(summary());
    vi.mocked(runs.close).mockResolvedValue(summary({ status: "closed" }));
    const tool = createAgentTool(runs, agents());

    const started = await tool.execute(
      "call-1",
      { name: "explorer", prompt: "Inspect", label: "Explore" },
      undefined,
      undefined,
      undefined as never
    );
    const messaged = await tool.execute(
      "call-2",
      { action: "message", id, message: "focus" },
      undefined,
      undefined,
      undefined as never
    );
    const closed = await tool.execute(
      "call-3",
      { action: "close", id },
      undefined,
      undefined,
      undefined as never
    );

    expect(text(started)).toBe(`Started run ${id} (explorer: Explore) [running]`);
    expect(text(messaged)).toBe(`Sent message to run ${id} (explorer: Explore) [running]`);
    expect(text(closed)).toBe(`Closed run ${id} (explorer: Explore) [closed]`);
    for (const reply of [started, messaged, closed]) {
      expect(text(reply)).not.toContain("explorer:1");
    }
  });

  it("says to use the run id start returned when the id is unknown", async () => {
    const runs = controller();
    vi.mocked(runs.list).mockReturnValue([summary()]);
    vi.mocked(runs.message).mockRejectedValue(
      new Error("Unknown agent run id: explorer:1")
    );
    const tool = createAgentTool(runs, agents());

    const status = await tool.execute(
      "call-1",
      { action: "status", id: "explorer:1" },
      undefined,
      undefined,
      undefined as never
    );
    const messaged = await tool.execute(
      "call-2",
      { action: "message", id: "explorer:1", message: "focus" },
      undefined,
      undefined,
      undefined as never
    );

    for (const reply of [status, messaged]) {
      expect((reply as any).isError).toBe(true);
      expect(text(reply)).toBe(
        "Unknown agent run explorer:1: use the run id `start` returned."
      );
    }
  });

  it("describes one handle, pushed results, and waiting only for a short check", () => {
    const tool = createAgentTool(controller(), agents());
    expect(tool.description).toContain("the run id `start` returned");
    expect(tool.description).toContain("reaches you when it finishes");
    expect(tool.description).toContain("wait: true");
    expect(tool.description).toContain("short check");
    expect(Object.keys((tool.parameters as any).properties)).toContain("wait");
  });
});

describe("agent tool waiting", () => {
  const id = "3f2c9a10-0000-4000-8000-000000000001";
  const done = summary({
    status: "completed",
    completed_at: 2,
    last_activity_at: 2,
    output: "found it",
  });

  it("returns the child's result from start in one call", async () => {
    const runs = controller();
    vi.mocked(runs.start).mockResolvedValue(summary());
    vi.mocked(runs.wait).mockResolvedValue(done);
    const acknowledgeCompletions = vi.fn();
    const tool = createAgentTool(runs, agents(), { acknowledgeCompletions });
    const signal = new AbortController().signal;

    const result = await tool.execute(
      "call-1",
      { name: "explorer", prompt: "Inspect", wait: true },
      signal,
      undefined,
      undefined as never
    );

    expect(runs.wait).toHaveBeenCalledWith(id, signal);
    expect(text(result)).toBe(`run ${id} (explorer: Explore) [completed]\nfound it`);
    expect((result as any).details.agent.status).toBe("completed");
    expect(acknowledgeCompletions).toHaveBeenCalledWith([id]);
  });

  it("returns a failed run as start's result", async () => {
    const runs = controller();
    vi.mocked(runs.start).mockResolvedValue(summary());
    vi.mocked(runs.wait).mockResolvedValue(
      summary({ status: "failed", completed_at: 2, error: "expired" })
    );
    const tool = createAgentTool(runs, agents());

    const result = await tool.execute(
      "call-1",
      { name: "explorer", prompt: "Inspect", wait: true },
      undefined,
      undefined,
      undefined as never
    );

    expect(text(result)).toBe(`run ${id} (explorer: Explore) [failed]\nAgent failed: expired`);
  });

  it("stops waiting on abort and leaves the run working", async () => {
    const runs = controller();
    vi.mocked(runs.start).mockResolvedValue(summary());
    vi.mocked(runs.get).mockReturnValue(summary());
    const abort = new AbortController();
    vi.mocked(runs.wait).mockImplementation(
      (_id, signal) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("wait aborted")))
        )
    );
    const tool = createAgentTool(runs, agents());

    const pending = tool.execute(
      "call-1",
      { name: "explorer", prompt: "Inspect", wait: true },
      abort.signal,
      undefined,
      undefined as never
    );
    await vi.waitFor(() => expect(runs.wait).toHaveBeenCalled());
    abort.abort();
    const result = await pending;

    expect((result as any).isError).toBeUndefined();
    expect(text(result)).toBe(
      `Stopped waiting: run ${id} (explorer: Explore) [running] keeps working; its result reaches you when it finishes.`
    );
    expect(runs.interrupt).not.toHaveBeenCalled();
  });

  it("waits on a run by the id start returned", async () => {
    const runs = controller();
    vi.mocked(runs.wait).mockResolvedValue(done);
    const tool = createAgentTool(runs, agents());

    const result = await tool.execute(
      "call-1",
      { action: "wait", id },
      undefined,
      undefined,
      undefined as never
    );

    expect(runs.wait).toHaveBeenCalledWith(id, undefined);
    expect(text(result)).toBe(`run ${id} (explorer: Explore) [completed]\nfound it`);
  });
});

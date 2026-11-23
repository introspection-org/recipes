import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_READ_CALL_ID,
  MEMORY_SNAPSHOT_ENTRY,
  registerMemoryContext,
} from "../src/memory-context.js";
import type { LoadMemoryIndexResult } from "../src/memory.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

function setup(
  load: () => LoadMemoryIndexResult,
  entries: unknown[] = [],
  branch?: unknown[],
) {
  const handlers = new Map<string, Handler>();
  const appended: unknown[] = [];
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    appendEntry: (customType: string, data: unknown) => {
      appended.push(data);
      entries.push({ type: "custom", customType, data });
    },
  };
  const ctx = {
    cwd: "/workspace",
    model: { api: "anthropic-messages", provider: "anthropic", id: "m" },
    ui: { notify: vi.fn() },
    sessionManager: { getBranch: () => branch ?? entries },
  };
  const start = registerMemoryContext(pi as never, "memories/MEMORY.md", load);
  const fire = (name: string, event: unknown = {}) =>
    name === "session_start"
      ? start(ctx as never)
      : handlers.get(name)?.(event, ctx);
  const context = (messages: unknown[]) =>
    fire("context", { type: "context", messages }) as {
      messages?: Array<{ role: string; content?: unknown }>;
    };
  return { fire, context, appended };
}

function loaded(
  content: string | null,
  maxBytes = 25_000,
): LoadMemoryIndexResult {
  return {
    memory:
      content === null
        ? null
        : {
            filePath: "/workspace/memories/MEMORY.md",
            baseDir: "/workspace/memories",
            content,
            maxLines: 200,
            maxBytes,
            truncated: false,
          },
    diagnostics: [],
  };
}

const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });

describe("registerMemoryContext", () => {
  it("reads the index once, right after the first user message", () => {
    const { fire, context, appended } = setup(() => loaded("likes jazz"));
    fire("session_start");
    expect(appended).toEqual([
      { path: "memories/MEMORY.md", content: "likes jazz" },
    ]);
    const { messages } = context([user("hi"), user("again")]);
    expect(messages?.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "user",
    ]);
    expect(messages?.[2]).toMatchObject({
      toolCallId: MEMORY_READ_CALL_ID,
      content: [{ type: "text", text: "likes jazz" }],
    });
    expect(context(messages ?? [])).toEqual({});
  });

  it("replays a continued conversation's snapshot, not the file", () => {
    const { fire, context, appended } = setup(
      () => loaded("new notes"),
      [
        {
          type: "custom",
          customType: MEMORY_SNAPSHOT_ENTRY,
          data: { path: "memories/MEMORY.md", content: "old notes" },
        },
      ],
    );
    fire("session_start");
    expect(appended).toEqual([]);
    expect(context([user("hi")]).messages?.[2]).toMatchObject({
      content: [{ type: "text", text: "old notes" }],
    });
  });

  it("takes a new snapshot after compaction, and adds nothing without memory", () => {
    let content: string | null = "first";
    const { fire, context, appended } = setup(() => loaded(content));
    fire("session_start");
    content = null;
    fire("session_compact");
    expect(appended.at(-1)).toEqual({ path: "", content: "" });
    expect(context([user("hi")])).toEqual({});
  });

  it("bounds a snapshot to its limits, as an override may exceed them", () => {
    const { fire, appended } = setup(() => loaded("x".repeat(30), 10));
    fire("session_start");
    expect(appended).toEqual([
      { path: "memories/MEMORY.md", content: "xxxxxxx..." },
    ]);
  });

  it("restores only a snapshot on the active branch", () => {
    const other = {
      type: "custom",
      customType: MEMORY_SNAPSHOT_ENTRY,
      data: { path: "memories/MEMORY.md", content: "other branch" },
    };
    const { fire, context } = setup(() => loaded("this branch"), [other], []);
    fire("session_start");
    expect(context([user("hi")]).messages?.[2]).toMatchObject({
      content: [{ type: "text", text: "this branch" }],
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_READ_CALL_ID,
  MEMORY_SNAPSHOT_ENTRY,
  MemoryContext,
} from "../src/memory-context.js";
import type { LoadMemoryIndexResult } from "../src/memory.js";

function setup(entries: unknown[] = []) {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      appended.push({ customType, data });
      entries.push({ type: "custom", customType, data });
    },
  };
  const ctx = {
    cwd: "/workspace",
    model: { api: "anthropic-messages", provider: "anthropic", id: "m" },
    ui: { notify: vi.fn() },
    sessionManager: { getEntries: () => entries },
  };
  return { pi, ctx, appended };
}

function loaded(content: string | null): () => LoadMemoryIndexResult {
  return () => ({
    memory:
      content === null
        ? null
        : {
            filePath: "/workspace/memories/MEMORY.md",
            baseDir: "/workspace/memories",
            content,
            maxLines: 200,
            maxBytes: 25_000,
            truncated: false,
          },
    diagnostics: [],
  });
}

const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });

describe("MemoryContext", () => {
  it("reads the index once after the first user message", () => {
    const { pi, ctx, appended } = setup();
    const memory = new MemoryContext(
      pi as never,
      "memories/MEMORY.md",
      loaded("likes jazz"),
    );
    memory.start(ctx as never);
    expect(appended).toEqual([
      {
        customType: MEMORY_SNAPSHOT_ENTRY,
        data: { path: "memories/MEMORY.md", content: "likes jazz" },
      },
    ]);
    const { messages } = memory.inject(
      { type: "context", messages: [user("hi"), user("again")] } as never,
      ctx as never,
    );
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
    expect(
      memory.inject({ type: "context", messages } as never, ctx as never),
    ).toEqual({});
  });

  it("replays a continued conversation's snapshot, not the file", () => {
    const entries = [
      {
        type: "custom",
        customType: MEMORY_SNAPSHOT_ENTRY,
        data: { path: "memories/MEMORY.md", content: "old notes" },
      },
    ];
    const { pi, ctx, appended } = setup(entries);
    const memory = new MemoryContext(
      pi as never,
      "memories/MEMORY.md",
      loaded("new notes"),
    );
    memory.start(ctx as never);
    expect(appended).toEqual([]);
    const { messages } = memory.inject(
      { type: "context", messages: [user("hi")] } as never,
      ctx as never,
    );
    expect(messages?.[2]).toMatchObject({
      content: [{ type: "text", text: "old notes" }],
    });
  });

  it("takes a new snapshot after compaction and adds nothing without memory", () => {
    const { pi, ctx, appended } = setup();
    let content: string | null = "first";
    const memory = new MemoryContext(pi as never, "memories/MEMORY.md", () =>
      loaded(content)(),
    );
    memory.start(ctx as never);
    content = null;
    memory.refresh(ctx as never);
    expect(appended.at(-1)?.data).toEqual({
      path: "memories/MEMORY.md",
      content: "",
    });
    expect(
      memory.inject(
        { type: "context", messages: [user("hi")] } as never,
        ctx as never,
      ),
    ).toEqual({});
  });
});

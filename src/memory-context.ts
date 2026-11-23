import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { boundMemoryContent, type LoadMemoryIndexResult } from "./memory.js";

/** Session entry holding a conversation's memory snapshot. */
export const MEMORY_SNAPSHOT_ENTRY = "recipe_memory_snapshot";
/** Tool call id of the read that carries the snapshot into the transcript. */
export const MEMORY_READ_CALL_ID = "toolu_recipe_memory_read";

interface MemorySnapshot {
  path: string;
  content: string;
}

/**
 * Memory enters a conversation as a read of its index, right after the first
 * user message, so the system prompt stays the same for every owner and a
 * continued or restored conversation replays the bytes it started with. The
 * index is read once per conversation, and again after compaction, which
 * rewrites the history anyway. The host calls the returned `start` on each
 * session start it runs a Recipe in; until then nothing is added.
 */
export function registerMemoryContext(
  pi: ExtensionAPI,
  indexPath: string | undefined,
  load: (cwd: string) => LoadMemoryIndexResult,
): (ctx: ExtensionContext) => void {
  let started = false;
  let snapshot: MemorySnapshot | null = null;

  function take(ctx: ExtensionContext): void {
    const loaded = load(ctx.cwd);
    for (const diagnostic of loaded.diagnostics)
      ctx.ui.notify(diagnostic.message, "warning");
    snapshot = loaded.memory
      ? {
          path: indexPath ?? loaded.memory.filePath,
          content: boundMemoryContent(loaded.memory),
        }
      : null;
    pi.appendEntry(
      MEMORY_SNAPSHOT_ENTRY,
      snapshot ?? { path: "", content: "" },
    );
  }

  function start(ctx: ExtensionContext): void {
    started = true;
    snapshot = null;
    const saved = ctx.sessionManager
      ?.getBranch()
      .filter(
        (entry) =>
          entry.type === "custom" && entry.customType === MEMORY_SNAPSHOT_ENTRY,
      )
      .at(-1);
    if (saved?.type === "custom") {
      const data = saved.data as MemorySnapshot | null;
      snapshot = data?.content ? data : null;
      return;
    }
    take(ctx);
  }

  pi.on("session_compact", (_event, ctx) => {
    if (started) take(ctx);
  });

  pi.on("context", (event, ctx) => {
    if (!snapshot || !ctx.model) return {};
    const messages = event.messages;
    if (
      messages.some(
        (message) =>
          message.role === "toolResult" &&
          message.toolCallId === MEMORY_READ_CALL_ID,
      )
    )
      return {};
    const first = messages.findIndex((message) => message.role === "user");
    if (first < 0) return {};
    const call = {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          id: MEMORY_READ_CALL_ID,
          name: "read",
          arguments: { path: snapshot.path },
        },
      ],
      api: ctx.model.api,
      provider: ctx.model.provider,
      model: ctx.model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse" as const,
      timestamp: 0,
    };
    const result = {
      role: "toolResult" as const,
      toolCallId: MEMORY_READ_CALL_ID,
      toolName: "read",
      content: [{ type: "text" as const, text: snapshot.content }],
      isError: false,
      timestamp: 0,
    };
    return {
      messages: [
        ...messages.slice(0, first + 1),
        call,
        result,
        ...messages.slice(first + 1),
      ],
    };
  });
  return start;
}

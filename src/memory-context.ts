import type {
  ContextEvent,
  ContextEventResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { LoadMemoryIndexResult } from "./memory.js";

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
 * restored or continued conversation replays the bytes it started with. The
 * index is read once per conversation, and again only after compaction, which
 * rewrites the history anyway.
 */
export class MemoryContext {
  private snapshot: MemorySnapshot | null = null;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly indexPath: string,
    private readonly load: (cwd: string) => LoadMemoryIndexResult,
  ) {}

  /** Restore the conversation's snapshot, or take one for a new conversation. */
  start(ctx: ExtensionContext): void {
    const saved = ctx.sessionManager
      .getEntries()
      .filter(
        (entry) =>
          entry.type === "custom" && entry.customType === MEMORY_SNAPSHOT_ENTRY,
      )
      .at(-1);
    if (saved && saved.type === "custom") {
      const data = saved.data as MemorySnapshot | null;
      this.snapshot = data?.content ? data : null;
      return;
    }
    this.take(ctx);
  }

  /** Take a new snapshot after compaction. */
  refresh(ctx: ExtensionContext): void {
    this.take(ctx);
  }

  /** Put the snapshot's read after the first user message, once. */
  inject(event: ContextEvent, ctx: ExtensionContext): ContextEventResult {
    const snapshot = this.snapshot;
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
  }

  private take(ctx: ExtensionContext): void {
    const loaded = this.load(ctx.cwd);
    for (const diagnostic of loaded.diagnostics)
      ctx.ui.notify(diagnostic.message, "warning");
    this.snapshot = loaded.memory
      ? { path: this.indexPath, content: loaded.memory.content }
      : null;
    this.pi.appendEntry(
      MEMORY_SNAPSHOT_ENTRY,
      this.snapshot ?? { path: this.indexPath, content: "" },
    );
  }
}

/** The memory context as an extension, for hosts that build their own session. */
export function memoryContextExtension(
  indexPath: string,
  load: (cwd: string) => LoadMemoryIndexResult,
) {
  return (pi: ExtensionAPI) => {
    const memory = new MemoryContext(pi, indexPath, load);
    pi.on("session_start", (_event, ctx) => memory.start(ctx));
    pi.on("session_compact", (_event, ctx) => memory.refresh(ctx));
    pi.on("context", (event, ctx) => memory.inject(event, ctx));
  };
}

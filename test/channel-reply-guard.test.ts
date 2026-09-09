import { describe, expect, it, vi } from "vitest";
import { createChannelConnectorModule, registerChannelTools, type ChannelAdapter } from "../src/channels/index.js";
import { channelCommand } from "./helpers/channel-command.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

function setup(requireReply?: boolean, origin = true) {
  const pi = createMockExtensionAPI();
  const reply = vi.fn<ChannelAdapter["reply"]>(async () => ({ ref: "message-1" }));
  const adapter = {
    provider: "test",
    capabilities: { react: false, edit: false, retract: false, read: false,
      attach: false, fetchFile: false, documents: false, resolveAuthors: false, permalinks: false },
    reply,
  } as ChannelAdapter;
  registerChannelTools(pi, adapter, {
    ...(requireReply === undefined ? {} : { requireReply }),
    target: () => {
      if (!origin) throw new Error("No origin");
      return { provider: "test", conversation: "C1", thread: "T1" };
    },
  });
  const start = () => pi.emitExtensionEvent({ type: "before_agent_start", prompt: "hello", systemPrompt: "base", systemPromptOptions: { cwd: process.cwd() } }, {});
  const end = (stopReason = "stop", signal?: AbortSignal) => pi.emitExtensionEvent({
    type: "agent_end", messages: [{ role: "assistant", stopReason } as never],
  }, { signal });
  const post = (final?: boolean) => channelCommand(pi, "reply").execute("call", { text: "Answer", ...(final === undefined ? {} : { final }) });
  return { pi, adapter, reply, start, end, post };
}

describe("required channel replies", () => {
  it("requires replies by default through the provider module and permits explicit opt-out", () => {
    const { adapter } = setup();
    const connector = createChannelConnectorModule({
      provider: "test", capabilities: adapter.capabilities,
      createSession: () => ({ adapter, target: { provider: "test", conversation: "C1" } }),
    });
    expect(() => connector.createExtension({ tools: ["channels"], commands: ["read"] })).toThrow("requireReply");
    expect(() => connector.createExtension({ tools: ["channels"], commands: ["read"], requireReply: false })).not.toThrow();
  });
  it("keeps origin in the system prompt across runs without rewriting user attribution", async () => {
    const s = setup();
    const [first] = await s.start() as Array<{ systemPrompt: string; message?: unknown }>;
    expect(first!.message).toBeUndefined();
    expect(first!.systemPrompt).toContain('"channel_id":"C1","thread_id":"T1"');
    const user = { role: "user", content: 'hello\n\n<channel_context>\n{"from":"U1","message_id":"100.1"}\n</channel_context>', timestamp: 0 };
    const [result] = await s.pi.emitExtensionEvent({ type: "context", messages: [
      user, { role: "custom", customType: "channel-context", content: "legacy", display: false, timestamp: 0 },
    ] } as never, {}) as Array<{ messages: unknown[] }>;
    expect(result!.messages).toEqual([user]);
    const [resumed] = await s.start() as Array<{ systemPrompt: string }>;
    expect(resumed!.systemPrompt).toBe(first!.systemPrompt);
  });

  it.each([
    { tools: [], commands: ["reply"] },
    { tools: ["channels"], commands: [] },
    { tools: ["channels"], commands: ["read"] },
  ])("rejects a required reply without an enabled reply tool: %j", (selection) => {
    const { adapter } = setup();
    const connector = createChannelConnectorModule({
      provider: "test", capabilities: adapter.capabilities,
      createSession: () => ({ adapter, target: { provider: "test", conversation: "C1" } }),
    });
    expect(() => connector.createExtension({ ...selection, requireReply: true })).toThrow("requireReply");
  });
  it("prompts and makes exactly one correction, then reports failure locally", async () => {
    const s = setup();
    const [prompt] = await s.start();
    expect((prompt as { systemPrompt: string }).systemPrompt).toContain("You must deliver your answer");
    await s.end();
    expect(s.pi.sentMessages[0]).toMatchObject({
      message: { customType: "channel-reply-required", display: false },
      options: { triggerTurn: true, deliverAs: "followUp" },
    });
    await s.end();
    await s.end();
    expect(s.pi.sentMessages).toHaveLength(2);
    expect(s.pi.sentMessages[1]).toMatchObject({
      message: { customType: "channel-delivery-failed", display: true },
      options: { triggerTurn: false },
    });
    expect(s.reply).not.toHaveBeenCalled();
  });

  it.each([undefined, true])("accepts successful final=%s without leaking final to the adapter", async (final) => {
    const s = setup();
    await s.start();
    await s.post(final);
    await s.end();
    expect(s.reply.mock.calls[0]?.[1]).toEqual({ text: "Answer" });
    expect(s.pi.sentMessages).toHaveLength(0);
  });

  it("does not count progress and allows the correction to deliver a final reply", async () => {
    const s = setup();
    await s.start();
    await s.post(false);
    await s.end();
    expect(s.pi.sentMessages[0]!.message.content).toContain('<channel_context>\n{"provider":"test","channel_id":"C1","thread_id":"T1","conversation_scope":"thread"}\n</channel_context>');
    await s.post();
    await s.end();
    expect(s.pi.sentMessages).toHaveLength(1);
  });

  it("does not count failed delivery and resets on the next user turn", async () => {
    const s = setup();
    await s.start();
    s.reply.mockRejectedValueOnce(new Error("transport failed"));
    await expect(s.post()).rejects.toThrow("transport failed");
    await s.end();
    await s.post();
    await s.end();
    await s.start();
    await s.end();
    expect(s.pi.sentMessages.filter((m) => m.options.triggerTurn)).toHaveLength(2);
  });

  it("checks queued user messages independently of an earlier final reply", async () => {
    const s = setup();
    await s.start();
    await s.post();
    await s.pi.emitExtensionEvent({ type: "message_start", message: { role: "user", content: "next", timestamp: Date.now() } }, {});
    await s.end();
    expect(s.pi.sentMessages).toHaveLength(1);
  });

  it.each([[false, true], [true, false]])("skips opt-out/originless turns (%s, %s)", async (enabled, origin) => {
    const s = setup(enabled, origin);
    await s.start();
    await s.end();
    expect(s.pi.sentMessages).toHaveLength(0);
  });

  it.each(["aborted", "error"])("does not retry %s runs", async (reason) => {
    const s = setup();
    await s.start();
    await s.end(reason);
    expect(s.pi.sentMessages).toHaveLength(0);
  });

  it("does not retry after cancellation", async () => {
    const s = setup();
    await s.start();
    await s.end("stop", AbortSignal.abort());
    expect(s.pi.sentMessages).toHaveLength(0);
  });
});

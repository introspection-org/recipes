import { describe, expect, it, vi } from "vitest";
import { channelCommand } from "./helpers/channel-command.js";
import { ChannelRefStore, registerChannelTools, type ChannelAdapter, type ChannelTarget } from "../src/channels/index.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

const origin = { provider: "test", conversation: "A", thread: "1" };
function setup(options: { target?: ChannelTarget | (() => ChannelTarget); targeting?: boolean; validateTarget?: (target: ChannelTarget) => void } = {}) {
  const pi = createMockExtensionAPI();
  const refs = new ChannelRefStore();
  const adapter: ChannelAdapter = {
    provider: "test",
    capabilities: { targeting: options.targeting ?? true, read: "channel", react: true, edit: true, retract: true, attach: false, fetchFile: true, documents: false, resolveAuthors: false, permalinks: false },
    reply: vi.fn(async (ctx) => ({ ref: ctx.refs.message({ conversation: ctx.target.conversation, thread: ctx.target.thread, id: "posted", authoredByAgent: true }) })),
    send: vi.fn(async (ctx) => ({ ref: ctx.refs.message({ conversation: ctx.target.conversation, thread: ctx.target.thread, id: "sent", authoredByAgent: true }) })),
    read: vi.fn(async (ctx) => ({ messages: [{ ref: ctx.refs.message({ conversation: ctx.target.conversation, thread: ctx.target.thread, id: "received" }), author: { id: "user" }, text: "hi" }], cursor: ctx.refs.cursor("provider-page") })),
    edit: vi.fn(async (_ctx, input) => ({ ref: input.ref })),
    retract: vi.fn(async () => {}),
    react: vi.fn(async () => {}),
    fetchFile: vi.fn(async () => ({ id: "f", path: "/tmp/file", name: "file", size: 1, sha256: "hash", mime_type: "text/plain" })),
  };
  registerChannelTools(pi, adapter, { refs, target: options.target ?? origin, validateTarget: options.validateTarget });
  const call = async (name: string, params: unknown = {}) => {
    const result = await channelCommand(pi, name)!.execute("call", params as never, undefined, undefined, undefined as never);
    return result.details as { ref: string; cursor: string; messages: Array<{ ref: string }>; target: ChannelTarget };
  };
  return { pi, refs, adapter, call };
}

describe("explicit channel targets", () => {
  it("distinguishes origin, explicit channel timeline, and explicit thread", async () => {
    const { call } = setup();
    expect((await call("read")).target).toEqual(origin);
    expect((await call("read", { channel_id: "B" })).target).toEqual({ provider: "test", conversation: "B", thread: null });
    expect((await call("read", { channel_id: "B", thread_id: "2" })).target).toEqual({ provider: "test", conversation: "B", thread: "2" });
    expect((await call("read", { thread_id: null })).target).toEqual({ provider: "test", conversation: "A", thread: null });
    expect((await call("read", { thread_id: "3" })).target.thread).toBe("3");
  });

  it("supports explicit operations without loading an absent origin", async () => {
    const target = vi.fn(() => { throw new Error("No origin"); });
    const { call } = setup({ target });
    await call("send", { channel_id: "B", text: "hello" });
    await call("read", { channel_id: "B" });
    expect(target).not.toHaveBeenCalled();
    await expect(call("reply", { text: "hi" })).rejects.toThrow("No origin");
    await expect(call("send", { text: "hi" })).rejects.toThrow("Invalid channels");
  });

  it("never changes reply's origin after a targeted read or send", async () => {
    const { call, adapter } = setup();
    await call("send", { channel_id: "B", thread_id: "2", text: "hello" });
    await call("read", { channel_id: "B" });
    await call("reply", { text: "reply" });
    expect(adapter.reply).toHaveBeenCalledWith(expect.objectContaining({ target: origin }), { text: "reply" });
  });

  it("uses the message's destination for mutations, not the origin", async () => {
    const { call, adapter } = setup();
    const { ref } = await call("send", { channel_id: "B", thread_id: "2", text: "hi" });
    await call("edit", { message: ref, text: "updated" });
    await call("react", { message: ref, emoji: "eyes" });
    await call("retract", { message: ref });
    for (const method of [adapter.edit, adapter.react, adapter.retract]) {
      expect(method).toHaveBeenCalledWith(expect.objectContaining({ target: { provider: "test", conversation: "B", thread: "2" } }), expect.anything());
    }
  });

  it("rejects edits to received messages and references from another session", async () => {
    const { call } = setup();
    const read = await call("read", { channel_id: "B" });
    await expect(call("edit", { message: read.messages[0]!.ref, text: "no" })).rejects.toThrow("not sent by this agent");
    const other = await setup().call("send", { channel_id: "B", text: "hi" });
    await expect(call("react", { message: other.ref, emoji: "eyes" })).rejects.toThrow("Unknown message reference");
  });

  it("scopes cursors to channel and thread, while allowing page-size changes", async () => {
    const { call, adapter } = setup();
    const page = await call("read", { channel_id: "B", thread_id: "2" });
    await expect(call("read", { cursor: page.cursor })).rejects.toThrow("another channel or thread");
    await expect(call("read", { channel_id: "B", cursor: page.cursor })).rejects.toThrow("another channel or thread");
    await expect(call("read", { channel_id: "C", thread_id: "2", cursor: page.cursor })).rejects.toThrow("another channel or thread");
    await call("read", { channel_id: "B", thread_id: "2", cursor: page.cursor, limit: 1 });
    expect(adapter.read).toHaveBeenLastCalledWith(expect.anything(), { limit: 1, cursor: "provider-page" });
  });

  it("keeps same provider message IDs in different channels distinct", async () => {
    const { call } = setup();
    const a = await call("send", { channel_id: "A", text: "hi" });
    const b = await call("send", { channel_id: "B", text: "hi" });
    expect(a.ref).not.toBe(b.ref);
  });

  it("rechecks host policy for reads, sends and existing message/file references", async () => {
    let allowed = true;
    const validateTarget = vi.fn((target: ChannelTarget) => { if (!allowed || target.conversation !== "B") throw new Error("denied"); });
    const { call, refs, adapter } = setup({ validateTarget });
    const post = await call("send", { channel_id: "B", text: "hi" });
    const file = refs.file({ conversation: "B", id: "F1" });
    await call("fetch_file", { file });
    expect(adapter.fetchFile).toHaveBeenCalledWith(expect.objectContaining({ target: { provider: "test", conversation: "B" } }), { file });
    allowed = false;
    await expect(call("edit", { message: post.ref, text: "no" })).rejects.toThrow("denied");
    await expect(call("fetch_file", { file })).rejects.toThrow("denied");
    await expect(call("read", { channel_id: "B" })).rejects.toThrow("denied");
    expect(adapter.edit).not.toHaveBeenCalled();
  });

  it("keeps legacy adapters bound even if callers bypass schema validation", async () => {
    const { pi, call, refs } = setup({ targeting: false });
    expect(channelCommand(pi, "send").parameters).toBeUndefined();
    await expect(call("read", { channel_id: "B" })).rejects.toThrow("Invalid channels");
    const message = refs.message({ conversation: "B", id: "1" });
    await expect(call("react", { message, emoji: "eyes" })).rejects.toThrow("outside the bound");
  });

  it("preserves a file's observed thread when policy changes", async () => {
    let revoked = false;
    const { call, adapter, refs } = setup({
      validateTarget: (target) => {
        if (revoked && target.thread === "2") throw new Error("thread revoked");
      },
    });
    let file = "";
    adapter.read = vi.fn(async (ctx) => {
      // The tool wrapper retains the read scope even if an adapter omits it.
      file = ctx.refs.file({ conversation: ctx.target.conversation, id: "F1" });
      return { messages: [] };
    });
    await call("read", { channel_id: "B", thread_id: "2" });
    expect(refs.resolveFile(file)).toMatchObject({ conversation: "B", thread: "2" });
    await call("fetch_file", { file });
    const threadFile = file;
    await call("read", { channel_id: "B" });
    expect(file).not.toBe(threadFile);
    revoked = true;
    vi.mocked(adapter.fetchFile!).mockClear();
    await expect(call("fetch_file", { file: threadFile })).rejects.toThrow("thread revoked");
    expect(adapter.fetchFile).not.toHaveBeenCalled();
    await call("fetch_file", { file });
    expect(adapter.fetchFile).toHaveBeenCalledTimes(1);
  });

  it("retains the bound thread for legacy message references without a thread", async () => {
    let revoked = false;
    const validateTarget = vi.fn((target: ChannelTarget) => {
      if (revoked && target.thread === origin.thread) throw new Error("thread revoked");
    });
    const { call, refs, adapter } = setup({ targeting: false, validateTarget });
    const message = refs.message({ conversation: origin.conversation, id: "legacy", authoredByAgent: true });
    await call("react", { message, emoji: "eyes" });
    expect(adapter.react).toHaveBeenCalledWith(expect.objectContaining({ target: origin }), expect.anything());
    revoked = true;
    await expect(call("react", { message, emoji: "eyes" })).rejects.toThrow("thread revoked");
    await expect(call("edit", { message, text: "updated" })).rejects.toThrow("thread revoked");
    await expect(call("retract", { message })).rejects.toThrow("thread revoked");
    expect(adapter.edit).not.toHaveBeenCalled();
    expect(adapter.retract).not.toHaveBeenCalled();
  });

  it("captures explicit thread scope for adapter message identities that omit it", async () => {
    let revoked = false;
    const { call, adapter, refs } = setup({ validateTarget: (target) => {
      if (revoked && target.thread === "2") throw new Error("thread revoked");
    } });
    adapter.send = vi.fn(async (ctx) => ({ ref: ctx.refs.message({ conversation: ctx.target.conversation, id: "sent", authoredByAgent: true }) }));
    adapter.read = vi.fn(async (ctx) => ({ messages: [{ ref: ctx.refs.message({ conversation: ctx.target.conversation, id: "received" }), author: { id: "user" }, text: "hi" }] }));
    const sent = await call("send", { channel_id: "B", thread_id: "2", text: "hi" });
    const read = await call("read", { channel_id: "B", thread_id: "2" });
    expect(refs.resolveMessage(sent.ref).thread).toBe("2");
    expect(refs.resolveMessage(read.messages[0]!.ref).thread).toBe("2");
    // Seeing the same provider IDs on the timeline must not widen old handles.
    const timeline = await call("read", { channel_id: "B" });
    await call("send", { channel_id: "B", text: "hi" });
    revoked = true;
    await expect(call("react", { message: read.messages[0]!.ref, emoji: "eyes" })).rejects.toThrow("thread revoked");
    await expect(call("edit", { message: sent.ref, text: "updated" })).rejects.toThrow("thread revoked");
    await expect(call("retract", { message: sent.ref })).rejects.toThrow("thread revoked");
    expect(adapter.react).not.toHaveBeenCalled();
    expect(adapter.edit).not.toHaveBeenCalled();
    expect(adapter.retract).not.toHaveBeenCalled();
    await call("react", { message: timeline.messages[0]!.ref, emoji: "eyes" });
  });

  it("rejects blank targets before calling the provider", async () => {
    const { call, adapter } = setup();
    await expect(call("send", { channel_id: " ", text: "hi" })).rejects.toThrow("must not be empty");
    await expect(call("read", { thread_id: " " })).rejects.toThrow("must not be empty");
    expect(adapter.send).not.toHaveBeenCalled();
    expect(adapter.read).not.toHaveBeenCalled();
  });
});

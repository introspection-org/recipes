import { channelCommand } from "./helpers/channel-command.js";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_SLACK_FILE_BYTES,
  SlackBotSession,
  SlackChannelAdapter,
  SlackFileSession,
  createSlackChannelSession,
  slackDownloadRoot,
  slackMessageBody,
  toPlainText,
  type SlackFetch,
} from "../packages/channels/slack/src/index.js";
import { writeAll } from "../packages/channels/slack/src/files.js";
import {
  ChannelRefStore,
  registerChannelTools,
  resolveChannelConfig,
} from "../src/channels/index.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

const cloudEnv = {
  INTROSPECTION_TOKEN: "session-locator",
  INTROSPECTION_EGRESS_URL: "http://egress.internal:8081",
};

interface FakeFetchOptions {
  reactionError?: string;
  file?: Record<string, unknown>;
  fileBody?: string;
  bridgeStatus?: number;
  bridgeRecorded?: boolean;
  bridgeSkipped?: string;
  bridgeStatuses?: number[];
  messages?: Array<Record<string, unknown>>;
  threadPages?: Record<
    string,
    { messages: Array<Record<string, unknown>>; nextCursor?: string }
  >;
  permalinks?: Record<string, string>;
  channelName?: string;
  channelPages?: Record<
    string,
    { channels: Array<Record<string, unknown>>; nextCursor?: string }
  >;
}

function fakeFile(overrides: Record<string, unknown> = {}) {
  return {
    id: "F123",
    name: "crash.png",
    mimetype: "image/png",
    size: 4,
    url_private_download: "https://files.slack.com/files-pri/T1-F123/crash.png",
    ...overrides,
  };
}

function fakeFetch(options: FakeFetchOptions = {}) {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const file = options.file ?? fakeFile();
  const fileBody = options.fileBody ?? "data";
  const impl = (async (url: string, init: Record<string, unknown> = {}) => {
    calls.push({ url: String(url), init });
    const parsed = new URL(String(url));
    if (parsed.pathname.startsWith("/api/reactions.") && options.reactionError) {
      return response({ payload: { ok: false, error: options.reactionError } });
    }
    if (parsed.hostname === "dp.example") {
      const status = options.bridgeStatuses?.shift() ?? options.bridgeStatus ?? 200;
      return response({
        ok: status < 400,
        status,
        payload: { acknowledged: true, result: { recorded: options.bridgeRecorded ?? true, ...(options.bridgeSkipped ? { skipped: options.bridgeSkipped } : {}) } },
      });
    }
    if (parsed.pathname.endsWith("/api/chat.postMessage")) {
      const sent = JSON.parse(String(init.body));
      return response({
        payload: {
          ok: true,
          channel: sent.channel,
          ts: "200.2",
          message: sent.thread_ts ? { thread_ts: sent.thread_ts } : {},
        },
      });
    }
    if (parsed.pathname.endsWith("/api/files.info")) {
      return response({ payload: { ok: true, file } });
    }
    if (parsed.pathname.endsWith("/api/conversations.list")) {
      const form = new URLSearchParams(String(init.body));
      const page = options.channelPages?.[form.get("cursor") ?? ""] ?? {
        channels: [],
      };
      return response({
        payload: {
          ok: true,
          channels: page.channels,
          response_metadata: { next_cursor: page.nextCursor ?? "" },
        },
      });
    }
    if (parsed.pathname.endsWith("/api/conversations.info")) {
      return response({
        payload: {
          ok: true,
          channel: { id: "C1", name: options.channelName ?? "support" },
        },
      });
    }
    if (parsed.pathname.endsWith("/api/chat.getPermalink")) {
      const form = new URLSearchParams(String(init.body));
      const permalink = options.permalinks?.[form.get("message_ts") ?? ""];
      return response({
        payload: { ok: true, ...(permalink ? { permalink } : {}) },
      });
    }
    if (parsed.pathname.endsWith("/api/conversations.replies") && options.threadPages) {
      const form = new URLSearchParams(String(init.body));
      const oldest = form.get("oldest");
      const page = options.threadPages[oldest === form.get("ts") ? "" : oldest ?? ""] ?? {
        messages: [],
      };
      return response({
        payload: {
          ok: true,
          messages: page.messages,
          response_metadata: { next_cursor: page.nextCursor ?? "" },
        },
      });
    }
    if (parsed.pathname.includes("/files-pri/")) {
      return response({ payload: {}, body: fileBody });
    }
    return response({
      payload: { ok: true, messages: options.messages ?? [{ ts: "100.1" }] },
    });
  }) as unknown as SlackFetch & { calls: typeof calls };
  impl.calls = calls;
  return impl;
}

function response(options: {
  ok?: boolean;
  status?: number;
  payload: unknown;
  body?: string;
}) {
  const bytes = Buffer.from(options.body ?? "");
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-length" && options.body !== undefined
          ? String(bytes.length)
          : null,
    },
    json: async () => options.payload,
    body:
      options.body === undefined
        ? null
        : (async function* stream() {
            yield new Uint8Array(bytes);
          })(),
  };
}

describe("channel configuration", () => {
  it("resolves the task destination for a Slack session", () => {
    const session = createSlackChannelSession({
      env: {
        INTROSPECTION_TASK_CHANNEL_PROVIDER: "slack",
        INTROSPECTION_TASK_CHANNEL_ID: "C_NEW",
      },
    });
    const target =
      typeof session.target === "function" ? session.target() : session.target;
    expect(target).toEqual({ provider: "slack", conversation: "C_NEW", thread: null });
  });

  it("resolves the provider-neutral task channel", () => {
    expect(
      resolveChannelConfig({
        INTROSPECTION_TASK_CHANNEL_PROVIDER: "slack",
        INTROSPECTION_TASK_CHANNEL_ID: "C1",
        INTROSPECTION_TASK_THREAD_ID: "100.1",
      }),
    ).toEqual({
      provider: "slack",
      channel_ref: "C1",
      thread_ref: "100.1",
    });
    expect(
      resolveChannelConfig({
        INTROSPECTION_TASK_CHANNEL_PROVIDER: "linear",
        INTROSPECTION_TASK_CHANNEL_ID: "I1",
      }),
    ).toEqual({
      provider: "linear",
      channel_ref: "I1",
      thread_ref: null,
    });
  });

  it("resolves configured and default workspace file roots", () => {
    expect(
      slackDownloadRoot(
        { INTROSPECTION_RUNTIME_FILES_DIR: "/workspace/files" },
        "/elsewhere",
      ),
    ).toBe("/workspace/files/slack");
    expect(slackDownloadRoot({}, "/somewhere")).toBe("/somewhere/files/slack");
  });
});

describe("SlackBotSession transport", () => {
  it("passes the tool cancellation signal to Slack requests", async () => {
    const fetchImpl = fakeFetch();
    const session = new SlackBotSession({
      env: cloudEnv,
      fetchImpl,
    });
    const controller = new AbortController();

    await session.call(
      "conversations.history",
      { channel: "C1" },
      "form",
      controller.signal,
    );

    expect(fetchImpl.calls[0]!.init.signal).toBe(controller.signal);
  });

  it("keeps the provider URL for the cloud egress dispatcher", async () => {
    const fetchImpl = fakeFetch();
    const session = new SlackBotSession({
      env: {
        INTROSPECTION_TOKEN: "session-locator",
        INTROSPECTION_EGRESS_URL: "http://egress.internal:8081",
      },
      fetchImpl,
    });
    await session.call("conversations.history", { channel: "C1" });
    expect(fetchImpl.calls[0]!.url).toBe(
      "https://slack.com/api/conversations.history",
    );
    expect(fetchImpl.calls[0]!.init.headers).toMatchObject({
      Authorization: "Bearer session-locator",
    });
    expect(fetchImpl.calls[0]!.init.headers).not.toHaveProperty("Host");
  });

  it("does not send a cloud locator without the provider egress URL", async () => {
    const fetchImpl = fakeFetch();
    const session = new SlackBotSession({
      env: { INTROSPECTION_TOKEN: "session-locator" },
      fetchImpl,
    });
    await expect(
      session.call("conversations.history", { channel: "C1" }),
    ).rejects.toThrow(/cloud egress environment/);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("posts once and records the reply bridge in cloud", async () => {
    const fetchImpl = fakeFetch();
    const session = new SlackBotSession({
      env: {
        INTROSPECTION_TASK_CHANNEL_PROVIDER: "slack",
        INTROSPECTION_TASK_CHANNEL_ID: "C1",
        INTROSPECTION_TASK_THREAD_ID: "100.1",
        INTROSPECTION_TOKEN: "session-locator",
        INTROSPECTION_EGRESS_URL: "http://egress.internal:8081",
        INTROSPECTION_BASE_API_URL: "https://dp.example",
        INTROSPECTION_TASK_ID: "task-1",
        INTROSPECTION_TASK_RUN_ID: "run-1",
      },
      fetchImpl,
    });
    const result = await session.sendMessage({
      text: "**hello**",
      to: { channel: "C1", thread_ts: "100.1" },
    });
    expect(result).toMatchObject({
      channel: "C1",
      ts: "200.2",
      thread_ts: "100.1",
      bridge_recorded: true,
    });
    expect(fetchImpl.calls).toHaveLength(2);
    expect(JSON.parse(String(fetchImpl.calls[0]!.init.body))).toMatchObject({
      channel: "C1",
      text: "hello",
      blocks: [{ type: "markdown", text: "**hello**" }],
      thread_ts: "100.1",
    });
    expect(JSON.parse(String(fetchImpl.calls[1]!.init.body))).toMatchObject({
      type: "connector_posted",
      run_id: "run-1",
      data: {
        provider: "slack",
        channel: "C1",
        ts: "200.2",
        thread_ts: "100.1",
      },
    });
  });

  it("splits generated markdown blocks at Slack's block limit", async () => {
    const fetchImpl = fakeFetch();
    const session = new SlackBotSession({
      env: cloudEnv,
      fetchImpl,
    });
    const text = "a".repeat(12_001);

    await session.sendMessage({ text, to: { channel: "C1" } });

    expect(JSON.parse(String(fetchImpl.calls[0]!.init.body))).toMatchObject({
      blocks: [
        { type: "markdown", text: "a".repeat(12_000) },
        { type: "markdown", text: "a" },
      ],
    });
  });

  it("retries transient routing registration without posting the Slack message again", async () => {
    const fetchImpl = fakeFetch({ bridgeStatuses: [503, 200] });
    const session = new SlackBotSession({
      env: { ...cloudEnv, INTROSPECTION_BASE_API_URL: "https://dp.example", INTROSPECTION_TASK_ID: "task-1", INTROSPECTION_TASK_RUN_ID: "run-1" },
      fetchImpl,
    });
    const result = await session.sendMessage({ text: "hello", to: { channel: "C1" }, mode: "send" });
    expect(result).toMatchObject({ ts: "200.2", bridge_recorded: true });
    expect(fetchImpl.calls.filter(call => call.url.includes("chat.postMessage"))).toHaveLength(1);
    expect(fetchImpl.calls.filter(call => call.url.includes("dp.example"))).toHaveLength(2);
  });

  it("does not claim routing when cloud intentionally declines registration", async () => {
    const fetchImpl = fakeFetch({ bridgeRecorded: false });
    const session = new SlackBotSession({
      env: { ...cloudEnv, INTROSPECTION_BASE_API_URL: "https://dp.example", INTROSPECTION_TASK_ID: "task-1" }, fetchImpl,
    });
    const result = await session.sendMessage({ text: "hello", to: { channel: "C2" }, mode: "send" });
    expect(result).toMatchObject({ ts: "200.2", bridge_recorded: false });
    expect(result.bridge_error).toBeUndefined();
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it("retains the posted reference when routing is stale or permanently rejected", async () => {
    for (const options of [{ bridgeStatus: 409 }, { bridgeSkipped: "stale_run" }]) {
      const fetchImpl = fakeFetch(options);
      const session = new SlackBotSession({
        env: { ...cloudEnv, INTROSPECTION_BASE_API_URL: "https://dp.example", INTROSPECTION_TASK_ID: "task-1" }, fetchImpl,
      });
      const result = await session.sendMessage({ text: "hello", to: { channel: "C2" }, mode: "send" });
      expect(result).toMatchObject({ ts: "200.2", bridge_recorded: false });
      expect(result.bridge_error).toBeTruthy();
      expect(fetchImpl.calls.filter(call => call.url.includes("chat.postMessage"))).toHaveLength(1);
      expect(fetchImpl.calls.filter(call => call.url.includes("dp.example"))).toHaveLength(options.bridgeStatus ? 1 : 3);
    }
  });

  it("sends and registers a new issue thread without an inbound Slack origin", async () => {
    const pi = createMockExtensionAPI();
    const fetchImpl = fakeFetch();
    const adapter = new SlackChannelAdapter(new SlackFileSession({
      env: { ...cloudEnv, INTROSPECTION_BASE_API_URL: "https://dp.example", INTROSPECTION_TASK_ID: "worker", INTROSPECTION_TASK_RUN_ID: "run" }, fetchImpl,
    }));
    registerChannelTools(pi, adapter, { target: () => { throw new Error("No inbound origin"); } });
    const sent = await channelCommand(pi, "send").execute("send-test", { channel_id: "C2", text: "Need guidance" });
    expect(sent!.details).toMatchObject({ bridge_recorded: true, target: { conversation: "C2", thread: "200.2" } });
    const registration = fetchImpl.calls.find(request => request.url.includes("dp.example"))!;
    expect(JSON.parse(String(registration.init.body)).data).toMatchObject({ mode: "send", channel: "C2", ts: "200.2", thread_ts: "200.2" });
  });

  it("returns a bridge warning without retrying a successful Slack post", async () => {
    const fetchImpl = fakeFetch({ bridgeStatus: 503 });
    const session = new SlackBotSession({
      env: {
        INTROSPECTION_TASK_CHANNEL_ID: "C1",
        INTROSPECTION_TOKEN: "session-locator",
        INTROSPECTION_EGRESS_URL: "http://egress.internal:8081",
        INTROSPECTION_BASE_API_URL: "https://dp.example",
        INTROSPECTION_TASK_ID: "task-1",
      },
      fetchImpl,
    });
    const result = await session.sendMessage({
      text: "hello",
      to: { channel: "C1" },
    });
    expect(result.bridge_recorded).toBe(false);
    expect(result.bridge_error).toMatch(/503/);
    expect(
      fetchImpl.calls.filter((call) => call.url.includes("chat.postMessage")),
    ).toHaveLength(1);
  });

  it("keeps a successful Slack post when bookkeeping is cancelled", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ ok: true, channel: "C1", ts: "200.2" }),
          body: null,
        };
      }
      controller.abort();
      throw new DOMException("The operation was aborted", "AbortError");
    };
    const session = new SlackBotSession({
      env: {
        INTROSPECTION_EGRESS_URL: "http://egress.internal:8081",
        INTROSPECTION_BASE_API_URL: "https://dp.example",
        INTROSPECTION_TASK_ID: "task-1",
        INTROSPECTION_TOKEN: "task-token",
      },
      fetchImpl,
    });

    const result = await session.sendMessage(
      { text: "hello", to: { channel: "C1" } },
      controller.signal,
    );

    expect(result).toMatchObject({
      channel: "C1",
      ts: "200.2",
      bridge_recorded: false,
      bridge_error: "The operation was aborted",
    });
    expect(calls).toBe(2);
  });
});

describe("Slack file downloads", () => {
  it("retries partial file writes until the whole chunk is written", async () => {
    const source = new Uint8Array([1, 2, 3, 4, 5]);
    const written: number[] = [];
    const writer = {
      async write(buffer: Uint8Array, offset = 0, length = buffer.byteLength) {
        const bytesWritten = Math.min(length, 2);
        written.push(...buffer.slice(offset, offset + bytesWritten));
        return { bytesWritten };
      },
    };

    await writeAll(writer, source);

    expect(written).toEqual([...source]);
  });

  it("writes a safe file with a verified digest", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "slack-bot-api-"));
    try {
      const fetchImpl = fakeFetch({
        file: fakeFile({ name: "../bad name.png" }),
      });
      const session = new SlackFileSession({
        env: cloudEnv,
        fetchImpl,
        cwd,
      });
      const result = await session.downloadFile({ file_id: "F123" });
      expect(result.path.startsWith(join(cwd, "files", "slack"))).toBe(true);
      expect(result.path.includes(".."), result.path).toBe(false);
      expect(result.sha256).toHaveLength(64);
      expect(await readFile(result.path, "utf8")).toBe("data");
      expect(
        (await readdir(join(cwd, "files", "slack"))).filter((name) =>
          name.includes("partial"),
        ),
      ).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects unsafe hosts and oversized files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "slack-bot-api-"));
    try {
      const unsafe = new SlackFileSession({
        env: cloudEnv,
        fetchImpl: fakeFetch({
          file: fakeFile({ url_private_download: "https://evil.example/file" }),
        }),
        cwd,
      });
      await expect(unsafe.downloadFile({ file_id: "F123" })).rejects.toThrow(
        /files\.slack\.com/,
      );

      const oversized = new SlackFileSession({
        env: cloudEnv,
        fetchImpl: fakeFetch({
          file: fakeFile({ size: MAX_SLACK_FILE_BYTES + 1 }),
        }),
        cwd,
      });
      await expect(oversized.downloadFile({ file_id: "F123" })).rejects.toThrow(
        /download limit/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("Slack channel tools", () => {
  it("resolves the Slack channel name as prompt metadata", async () => {
    const fetchImpl = fakeFetch({ channelName: "incident-triage" });
    const adapter = new SlackChannelAdapter(
      new SlackFileSession({
        env: cloudEnv,
        fetchImpl,
      }),
    );

    await expect(
      adapter.enrichTarget({
        target: { provider: "slack", conversation: "C1", thread: null },
        refs: new ChannelRefStore(),
      }),
    ).resolves.toMatchObject({ name: "incident-triage" });
    expect(fetchImpl.calls[0]!.url).toBe(
      "https://slack.com/api/conversations.info",
    );
  });

  function slackTools(options: FakeFetchOptions = {}, cwd?: string) {
    const pi = createMockExtensionAPI();
    const fetchImpl = fakeFetch(options);
    const adapter = new SlackChannelAdapter(
      new SlackFileSession({ env: cloudEnv, fetchImpl, cwd }),
    );
    registerChannelTools(pi, adapter, {
      target: { provider: "slack", conversation: "C1", thread: "100.1" },
    });
    return { pi, fetchImpl };
  }

  const call = (pi: ReturnType<typeof createMockExtensionAPI>, name: string, params: unknown) =>
    pi.tools
      .get("channels")
      ?.execute("tool-call", { ...(params as object), command: name.replace("channel_", "") } as never, undefined, undefined, undefined as never);

  it("lists every accessible channel across Slack pages", async () => {
    const { pi, fetchImpl } = slackTools({
      channelPages: {
        "": {
          channels: [
            { id: "C1", name: "general", is_member: true },
            { id: "C2", name: "not-joined", is_member: false },
            { id: "C3", name: "archived", is_member: true, is_archived: true },
          ],
          nextCursor: "page-2",
        },
        "page-2": {
          channels: [
            {
              id: "G1",
              name: "incident-response",
              is_member: true,
              is_private: true,
            },
          ],
        },
      },
    });

    const result = await call(pi, "channel_list", {});

    expect(result!.details).toEqual([
      { id: "C1", name: "general", kind: "public_channel" },
      {
        id: "G1",
        name: "incident-response",
        kind: "private_channel",
      },
    ]);
    const calls = fetchImpl.calls.filter((request) =>
      request.url.includes("conversations.list"),
    );
    expect(calls).toHaveLength(2);
    expect(new URLSearchParams(String(calls[1]!.init.body)).get("cursor")).toBe(
      "page-2",
    );
  });

  it("sends to another channel and asks cloud to register follow-up routing", async () => {
    const pi = createMockExtensionAPI();
    const fetchImpl = fakeFetch();
    const adapter = new SlackChannelAdapter(new SlackFileSession({ env: { ...cloudEnv, INTROSPECTION_BASE_API_URL: "https://dp.example", INTROSPECTION_TASK_ID: "task", INTROSPECTION_TOKEN: "locator" }, fetchImpl }));
    registerChannelTools(pi, adapter, { target: { provider: "slack", conversation: "C1", thread: "100.1" } });
    const sent = await call(pi, "channel_send", { channel_id: "C2", text: "hello" });
    const details = sent!.details as { ref: string };
    expect(sent!.details).toMatchObject({ target: { conversation: "C2", thread: "200.2" }, bridge_recorded: true });
    const post = fetchImpl.calls.find((request) => request.url.includes("chat.postMessage"))!;
    expect(JSON.parse(String(post.init.body))).toMatchObject({ channel: "C2" });
    expect(JSON.parse(String(post.init.body))).not.toHaveProperty("thread_ts");
    expect(fetchImpl.calls.some((request) => request.url.includes("dp.example"))).toBe(true);
    const registration = fetchImpl.calls.find((request) => request.url.includes("dp.example"))!;
    expect(JSON.parse(String(registration.init.body)).data.mode).toBe("send");
    await call(pi, "channel_edit", { message: details.ref, text: "updated" });
    const edit = fetchImpl.calls.find((request) => request.url.includes("chat.update"))!;
    expect(JSON.parse(String(edit.init.body))).toMatchObject({ channel: "C2", ts: "200.2" });
    await call(pi, "channel_reply", { text: "origin" });
    const posts = fetchImpl.calls.filter((request) => request.url.includes("chat.postMessage"));
    expect(JSON.parse(String(posts[1]!.init.body))).toMatchObject({ channel: "C1", thread_ts: "100.1" });
  });

  it.each([0, 3])("returns usable thread references from a channel with %i replies", async (replyCount) => {
    const { pi, fetchImpl } = slackTools({ messages: [{ ts: "900.1", text: "root", reply_count: replyCount }] });
    const read = await call(pi, "channel_read", { channel_id: "C2" });
    expect(read!.details).toMatchObject({ target: { conversation: "C2", thread: null }, next_direction: "older", messages: [{ thread_id: "900.1", reply_count: replyCount }] });
    const history = fetchImpl.calls.find((request) => request.url.includes("conversations.history"))!;
    expect(new URLSearchParams(String(history.init.body)).get("channel")).toBe("C2");
    await call(pi, "channel_read", { channel_id: "C2", thread_id: "900.1" });
    const thread = fetchImpl.calls.find((request) => request.url.includes("conversations.replies"))!;
    expect(new URLSearchParams(String(thread.init.body)).get("ts")).toBe("900.1");
    await call(pi, "channel_send", { channel_id: "C2", thread_id: "900.1", text: "thread reply" });
    const post = fetchImpl.calls.find((request) => request.url.includes("chat.postMessage"))!;
    expect(JSON.parse(String(post.init.body))).toMatchObject({ channel: "C2", thread_ts: "900.1" });
  });

  it("does not reuse channel metadata for a different target", async () => {
    const fetchImpl = fakeFetch();
    const adapter = new SlackChannelAdapter(new SlackFileSession({ env: cloudEnv, fetchImpl }));
    const refs = new ChannelRefStore();
    const a = await adapter.enrichTarget({ refs, target: { provider: "slack", conversation: "C1", name: "first" } });
    const b = await adapter.enrichTarget({ refs, target: { provider: "slack", conversation: "C2", name: "second" } });
    expect(a.name).toBe("first");
    expect(b.name).toBe("second");
  });

  it("posts to the context's conversation, not the session's own origin", async () => {
    // A direct-host caller can bind a context that differs from the session
    // environment. Every other tool acts on the context, so reply must too —
    // otherwise the prompt describes one conversation and channel_reply writes
    // to another.
    const pi = createMockExtensionAPI();
    const fetchImpl = fakeFetch();
    registerChannelTools(
      pi,
      new SlackChannelAdapter(new SlackFileSession({ env: cloudEnv, fetchImpl })),
      { target: { provider: "slack", conversation: "C-OTHER", thread: "900.9" } },
    );
    await call(pi, "channel_reply", { text: "hi" });

    const post = fetchImpl.calls.find((c) => c.url.includes("chat.postMessage"))!;
    expect(JSON.parse(String(post.init.body))).toMatchObject({
      channel: "C-OTHER",
      thread_ts: "900.9",
    });
  });

  it("returns unthreaded messages oldest-first, as the tool promises", async () => {
    // conversations.history is newest-first while conversations.replies is
    // oldest-first; a backwards transcript still reads as a conversation, so
    // nothing downstream would catch it.
    const pi = createMockExtensionAPI();
    const fetchImpl = fakeFetch({
      messages: [
        { ts: "300.3", text: "third", user: "U1" },
        { ts: "200.2", text: "second", user: "U1" },
        { ts: "100.1", text: "first", user: "U1" },
      ],
    });
    registerChannelTools(
      pi,
      new SlackChannelAdapter(new SlackFileSession({ env: cloudEnv, fetchImpl })),
      { target: { provider: "slack", conversation: "C1", thread: null } },
    );
    const result = (await call(pi, "channel_read", {})) as {
      details: { messages: Array<{ text: string }> };
    };
    expect(result.details.messages.map((m) => m.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("attaches Slack permalinks to message rows", async () => {
    const permalink = "https://example.slack.com/archives/C1/p100100";
    const { pi } = slackTools({
      messages: [{ ts: "100.1", text: "first", user: "U1" }],
      permalinks: { "100.1": permalink },
    });

    const history = (await call(pi, "channel_read", {})) as {
      details: { messages: Array<{ permalink?: string }> };
    };

    expect(history.details.messages[0]?.permalink).toBe(permalink);
  });

  it("reads one bounded thread page at a time, paging forward", async () => {
    const messages = Array.from({ length: 17 }, (_, index) => ({
      ts: `${index + 1}.1`,
      text: `message ${index + 1}`,
      user: "U1",
    }));
    const { pi, fetchImpl } = slackTools({
      threadPages: {
        "": {
          messages: messages.slice(0, 8),
          nextCursor: "page-2",
        },
        "8.1": {
          messages: messages.slice(8),
        },
      },
    });

    const first = (await call(pi, "channel_read", { limit: 100 })) as {
      details: { messages: Array<{ text: string }>; cursor?: string };
    };

    expect(first.details.messages.map((message) => message.text)).toEqual(
      messages.slice(0, 8).map((message) => message.text),
    );
    expect(first.details.cursor).toMatch(/^cur_/);
    const firstRequest = fetchImpl.calls.find((request) =>
      request.url.includes("conversations.replies"),
    )!;
    expect(new URLSearchParams(String(firstRequest.init.body)).get("limit")).toBe(
      "15",
    );
    expect(fetchImpl.calls.filter((request) => request.url.includes("conversations.replies"))).toHaveLength(1);
    expect(first.details).toMatchObject({ next_direction: "newer" });

    const second = (await call(pi, "channel_read", {
      cursor: first.details.cursor,
    })) as {
      details: { messages: Array<{ text: string }>; cursor?: string };
    };
    expect(second.details.messages.map((message) => message.text)).toEqual(
      messages.slice(8).map((message) => message.text),
    );
    expect(second.details.cursor).toBeUndefined();
    // Each model page makes just one provider history request.
    expect(
      fetchImpl.calls.filter((request) =>
        request.url.includes("conversations.replies"),
      ),
    ).toHaveLength(2);
  });

  it("bounds pages and includes Slack's repeated root only once", async () => {
    const root = { ts: "100.1", text: "root" };
    const { pi, fetchImpl } = slackTools({ threadPages: {
      "": { messages: [root, { ts: "101.1", text: "one" }], nextCursor: "next" },
      "101.1": { messages: [root, { ts: "102.1", text: "two" }], nextCursor: "last" },
      "102.1": { messages: [root, { ts: "103.1", text: "three" }] },
    } });
    let cursor: string | undefined;
    const texts: string[] = [];
    for (let index = 0; index < 4; index++) {
      const result = (await call(pi, "channel_read", { limit: 1, cursor })) as {
        details: { messages: Array<{ text: string }>; cursor?: string };
      };
      expect(result.details.messages).toHaveLength(1);
      texts.push(result.details.messages[0]!.text);
      cursor = result.details.cursor;
    }
    expect(texts).toEqual(["root", "one", "two", "three"]);
    expect(cursor).toBeUndefined();
    const requests = fetchImpl.calls.filter(request => request.url.includes("conversations.replies"));
    expect(requests).toHaveLength(3);
    expect(requests.map(request => new URLSearchParams(String(request.init.body)).get("oldest"))).toEqual(["100.1", "101.1", "102.1"]);
  });

  it("passes the current limit when requesting the next thread page", async () => {
    const messages = Array.from({ length: 17 }, (_, index) => ({
      ts: `${index + 1}.1`,
      text: `message ${index + 1}`,
      user: "U1",
    }));
    const { pi, fetchImpl } = slackTools({ threadPages: {
      "": { messages: messages.slice(0, 1), nextCursor: "next" },
      "1.1": { messages: messages.slice(1, 16), nextCursor: "last" },
    } });

    const first = (await call(pi, "channel_read", { limit: 1 })) as {
      details: { messages: Array<{ text: string }>; cursor?: string };
    };
    expect(first.details.messages.map((message) => message.text)).toEqual([
      "message 1",
    ]);

    const second = (await call(pi, "channel_read", {
      cursor: first.details.cursor,
      limit: 15,
    })) as {
      details: { messages: Array<{ text: string }>; cursor?: string };
    };
    expect(second.details.messages.map((message) => message.text)).toEqual(
      messages.slice(1, 16).map((message) => message.text),
    );
    expect(second.details.cursor).toBeDefined();
    expect(fetchImpl.calls.filter((request) => request.url.includes("conversations.replies")).map((request) => new URLSearchParams(String(request.init.body)).get("limit"))).toEqual(["1", "15"]);
  });

  it("uses Slack bot profile names for bot-authored messages", async () => {
    const { pi, fetchImpl } = slackTools({
      messages: [
        {
          ts: "100.1",
          text: "Automated update",
          bot_id: "B1",
          bot_profile: { id: "B1", name: "Release Bot" },
        },
      ],
    });

    const history = (await call(pi, "channel_read", {})) as {
      details: {
        messages: Array<{
          author: { id: string; display_name?: string };
        }>;
      };
    };

    expect(history.details.messages[0]?.author).toEqual({
      id: "B1",
      display_name: "Release Bot",
    });
    expect(fetchImpl.calls.some((call) => call.url.includes("users.info"))).toBe(
      false,
    );
  });

  it("refuses a file id the model supplied rather than saw", async () => {
    const { pi } = slackTools();
    // The P1 this closes: a bot can read files in every conversation it is in,
    // so a raw Slack file id is an addressing argument by another name.
    await expect(call(pi, "channel_fetch_file", { file: "F123" })).rejects.toThrow(
      /Unknown file reference/,
    );
  });

  it("downloads a file it handed out a reference for", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "slack-channel-tools-"));
    try {
      const { pi } = slackTools(
        {
          messages: [
            {
              ts: "100.1",
              text: "see this",
              user: "U1",
              files: [
                { id: "F123", name: "crash.png", mimetype: "image/png" },
              ],
            },
          ],
        },
        cwd,
      );
      const history = (await call(pi, "channel_read", {})) as {
        details: { messages: Array<{ attachments?: Array<{ id: string }> }> };
      };
      const ref = history.details.messages[0]!.attachments![0]!.id;
      expect(ref).toMatch(/^file_/);

      const file = (await call(pi, "channel_fetch_file", { file: ref })) as {
        details: { name: string; path: string };
      };
      expect(file.details.name).toContain("crash.png");
      expect(file.details.path.startsWith(join(cwd, "files", "slack"))).toBe(
        true,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("registers the neutral surface Slack supports and nothing else", () => {
    const { pi } = slackTools();
    expect([...pi.tools.keys()]).toEqual(["channels"]);
  });

  it("replies to the bound conversation and returns an opaque reference", async () => {
    const { pi, fetchImpl } = slackTools();
    const result = (await call(pi, "channel_reply", { text: "**hi**" })) as {
      details: { ref: string };
    };

    const post = JSON.parse(
      String(
        fetchImpl.calls.find((c) => c.url.includes("chat.postMessage"))!.init.body,
      ),
    );
    expect(post).toMatchObject({ channel: "C1", thread_ts: "100.1" });
    expect(result.details.ref).toMatch(/^msg_/);
    expect(JSON.stringify(result.details)).not.toContain("200.2");
  });

  it("returns a posted reply when permalink lookup is cancelled", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.includes("chat.postMessage")) {
        return response({
          payload: {
            ok: true,
            channel: "C1",
            ts: "200.2",
            message: { thread_ts: "100.1" },
          },
        });
      }
      controller.abort();
      throw new DOMException("The operation was aborted", "AbortError");
    }) as SlackFetch;
    const pi = createMockExtensionAPI();
    registerChannelTools(
      pi,
      new SlackChannelAdapter(
        new SlackFileSession({ env: cloudEnv, fetchImpl }),
      ),
      { target: { provider: "slack", conversation: "C1", thread: "100.1" } },
    );

    const result = (await channelCommand(pi, "reply")!.execute(
      "tool-call",
      { text: "hello" },
      controller.signal,
      undefined,
      undefined as never,
    )) as { details: { ref: string } };

    expect(result.details.ref).toMatch(/^msg_/);
    expect(calls.filter((url) => url.includes("chat.postMessage"))).toHaveLength(
      1,
    );
    expect(calls.filter((url) => url.includes("chat.getPermalink"))).toHaveLength(
      1,
    );
  });

  it("rejects a reference the session never minted", async () => {
    const { pi } = slackTools();
    await expect(
      call(pi, "channel_react", { message: "msg_forged", emoji: "eyes" }),
    ).rejects.toThrow(/Unknown message reference/);
  });

  it("adds reactions by default and removes them when requested", async () => {
    const { pi, fetchImpl } = slackTools();
    const posted = (await call(pi, "channel_reply", { text: "first" })) as {
      details: { ref: string };
    };

    await call(pi, "channel_react", {
      message: posted.details.ref,
      emoji: ":eyes:",
    });
    await call(pi, "channel_react", {
      message: posted.details.ref,
      emoji: ":eyes:",
      action: "remove",
    });

    const reactions = fetchImpl.calls.filter((call) =>
      call.url.includes("/api/reactions."),
    );
    expect(reactions.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/reactions.add",
      "/api/reactions.remove",
    ]);
    for (const reaction of reactions) {
      expect(
        Object.fromEntries(new URLSearchParams(String(reaction.init.body))),
      ).toMatchObject({
        channel: "C1",
        timestamp: "200.2",
        name: "eyes",
      });
    }
  });

  it.each([
    ["add", "already_reacted"],
    ["remove", "no_reaction"],
  ])("treats repeated reaction %s as success", async (action, reactionError) => {
    const { pi } = slackTools({ reactionError });
    const posted = (await call(pi, "channel_reply", { text: "first" })) as { details: { ref: string } };
    await expect(call(pi, "channel_react", { message: posted.details.ref, emoji: "eyes", action })).resolves.toBeDefined();
  });

  it("does not swallow other reaction errors", async () => {
    const { pi } = slackTools({ reactionError: "missing_scope" });
    const posted = (await call(pi, "channel_reply", { text: "first" })) as { details: { ref: string } };
    await expect(call(pi, "channel_react", { message: posted.details.ref, emoji: "eyes" })).rejects.toThrow("missing_scope");
  });

  it("rejects a Slack reaction without a normalized emoji name", async () => {
    const { pi, fetchImpl } = slackTools();
    const posted = (await call(pi, "channel_reply", { text: "first" })) as {
      details: { ref: string };
    };

    await expect(
      call(pi, "channel_react", {
        message: posted.details.ref,
        emoji: ":::",
      }),
    ).rejects.toThrow(/Slack reaction must name an emoji/);
    expect(
      fetchImpl.calls.some((request) => request.url.includes("reactions.add")),
    ).toBe(false);
  });

  it("refuses to edit or retract a message the agent did not author", async () => {
    const { pi } = slackTools();
    const read = (await call(pi, "channel_read", {})) as {
      details: { messages: Array<{ ref: string }> };
    };
    const theirs = read.details.messages[0]!.ref;

    await expect(
      call(pi, "channel_edit", { message: theirs, text: "rewritten" }),
    ).rejects.toThrow(/not sent by this agent/);
    await expect(call(pi, "channel_retract", { message: theirs })).rejects.toThrow(
      /not sent by this agent/,
    );
  });

  it("edits and retracts a message the agent posted", async () => {
    const { pi, fetchImpl } = slackTools();
    const posted = (await call(pi, "channel_reply", { text: "first" })) as {
      details: { ref: string };
    };

    await call(pi, "channel_edit", {
      message: posted.details.ref,
      text: "second",
    });
    await call(pi, "channel_retract", { message: posted.details.ref });

    const update = JSON.parse(
      String(fetchImpl.calls.find((c) => c.url.includes("chat.update"))!.init.body),
    );
    expect(update).toMatchObject({ channel: "C1", ts: "200.2" });

    const deletion = new URLSearchParams(
      String(fetchImpl.calls.find((c) => c.url.includes("chat.delete"))!.init.body),
    );
    expect(Object.fromEntries(deletion)).toMatchObject({
      channel: "C1",
      ts: "200.2",
    });
  });

  it("retains a reply permalink when the message is later edited", async () => {
    const permalink = "https://example.slack.com/archives/C1/p200200";
    const { pi } = slackTools({ permalinks: { "200.2": permalink } });
    const posted = (await call(pi, "channel_reply", { text: "first" })) as {
      details: { ref: string; permalink?: string };
    };

    const edited = (await call(pi, "channel_edit", {
      message: posted.details.ref,
      text: "second",
    })) as { details: { ref: string; permalink?: string } };

    expect(posted.details.permalink).toBe(permalink);
    expect(edited.details).toEqual({
      ref: posted.details.ref,
      permalink,
    });
  });

  it("splits long edited Markdown into Slack blocks", async () => {
    const { pi, fetchImpl } = slackTools();
    const posted = (await call(pi, "channel_reply", { text: "first" })) as {
      details: { ref: string };
    };
    const text = "a".repeat(12_001);

    await call(pi, "channel_edit", {
      message: posted.details.ref,
      text,
    });

    const update = JSON.parse(
      String(fetchImpl.calls.find((c) => c.url.includes("chat.update"))!.init.body),
    );
    expect(update.blocks).toEqual([
      { type: "markdown", text: "a".repeat(12_000) },
      { type: "markdown", text: "a" },
    ]);
  });

  it("reads earlier messages from the bound conversation", async () => {
    const { pi, fetchImpl } = slackTools();
    await call(pi, "channel_read", { limit: 5 });

    const read = fetchImpl.calls.find((c) =>
      c.url.includes("conversations.replies"),
    )!;
    expect(String(read.init.body)).toContain("channel=C1");
    expect(String(read.init.body)).toContain("ts=100.1");
  });

  it("splits oversized Markdown into valid Slack blocks", () => {
    expect(slackMessageBody("a".repeat(12_001))).toEqual({
      text: "a".repeat(12_001),
      blocks: [
        { type: "markdown", text: "a".repeat(12_000) },
        { type: "markdown", text: "a" },
      ],
    });
  });

  it("does not split Unicode surrogate pairs at a block boundary", () => {
    const markdown = `${"a".repeat(11_999)}😀b`;

    expect(slackMessageBody(markdown).blocks).toEqual([
      { type: "markdown", text: `${"a".repeat(11_999)}😀` },
      { type: "markdown", text: "b" },
    ]);
  });

  it("rejects Markdown that would exceed Slack's 50 block limit", () => {
    expect(() => slackMessageBody("a".repeat(12_000 * 50 + 1))).toThrow(
      "Slack Markdown exceeds the 50 block limit for one message",
    );
  });
});

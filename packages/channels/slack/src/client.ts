import { setTimeout } from "node:timers/promises";

import type { ChannelEnvironment } from "@introspection-ai/recipes/channels";

import { slackMessageBody } from "./format.js";

const SLACK_API_BASE = "https://slack.com/api";

export interface SlackHttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null | undefined };
  json(): Promise<unknown>;
  body: AsyncIterable<Uint8Array> | null;
}

export type SlackFetch = (
  url: string,
  init: {
    method?: string;
    headers: Record<string, string>;
    body?: string;
    redirect?: "error";
    signal?: AbortSignal;
  },
) => Promise<SlackHttpResponse>;

export interface SlackBotSessionOptions {
  env?: ChannelEnvironment;
  fetchImpl?: SlackFetch;
}

export interface SlackApiResult {
  ok?: boolean;
  error?: string;
  channel?: string;
  ts?: string;
  message?: { thread_ts?: string };
  [key: string]: unknown;
}

export interface SlackPostResult {
  ok: true;
  channel: string;
  ts: string;
  thread_ts: string;
  bridge_recorded: boolean;
  bridge_error?: string;
}

class SlackBridgeError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

type SlackEncoding = "json" | "form";

export class SlackApiError extends Error {
  constructor(readonly method: string, readonly code: string) {
    super(`Slack ${method} failed: ${code}`);
  }
}

function configured(value: string | undefined): value is string {
  return Boolean(value && value !== "undefined" && value !== "null");
}

function bodyFor(
  params: Record<string, unknown>,
  encoding: SlackEncoding,
): { contentType: string; body: string } {
  if (encoding === "json") {
    return {
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(params),
    };
  }
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    form.set(key, typeof value === "string" ? value : String(value));
  }
  return {
    contentType: "application/x-www-form-urlencoded; charset=utf-8",
    body: form.toString(),
  };
}

export class SlackBotSession {
  readonly env: ChannelEnvironment;
  readonly fetchImpl: SlackFetch;

  constructor(options: SlackBotSessionOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as SlackFetch);
  }

  request(
    url: URL,
    init: Omit<Parameters<SlackFetch>[1], "headers"> & {
      headers?: Record<string, string>;
    },
  ): Promise<SlackHttpResponse> {
    const locator = this.env.INTROSPECTION_TOKEN?.trim();
    const egressUrl = this.env.INTROSPECTION_EGRESS_URL?.trim();
    if (!locator || !egressUrl) {
      throw new Error(
        "Slack tools require the Introspection cloud egress environment. Use introspection dev to test channel recipes.",
      );
    }
    // Keep the provider URL intact. The runtime's proxy fetch dispatcher uses
    // INTROSPECTION_EGRESS_URL to dial the proxy while preserving this host as
    // the HTTP authority. Rewriting the URL here would make the proxy itself
    // the authority, so Envoy could neither route the request nor select the
    // connector credential.
    return this.fetchImpl(url.toString(), {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${locator}`,
      },
    });
  }

  async call(
    method: string,
    params: Record<string, unknown>,
    encoding: SlackEncoding = "form",
    signal?: AbortSignal,
  ): Promise<SlackApiResult> {
    const encoded = bodyFor(params, encoding);
    const response = await this.request(
      new URL(`${SLACK_API_BASE}/${method}`),
      {
        method: "POST",
        headers: { "Content-Type": encoded.contentType },
        body: encoded.body,
        redirect: "error",
        signal,
      },
    );
    if (!response.ok) {
      throw new Error(`Slack ${method} returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as SlackApiResult;
    if (payload.ok !== true) {
      throw new SlackApiError(method, payload.error ?? "unknown error");
    }
    return payload;
  }

  /**
   * Post into a conversation the caller has already resolved.
   *
   * `to` is required rather than defaulted from the environment: the caller —
   * the adapter — holds the trusted `ChannelAdapterContext.target`, and if this
   * method resolved its own destination the two could disagree, so
   * the prompt metadata and `channels read` would describe one conversation while
   * `channels reply` posted into another. Falling back to the origin here is
   * exactly the kind of second, quieter source of truth the bound tier exists
   * to remove.
   */
  async sendMessage(input: {
    text: string;
    plain_text?: string;
    to: { channel: string; thread_ts?: string | null };
    /** Callers can opt out of platform follow-up registration. */
    record_bridge?: boolean;
    mode?: "send" | "reply";
  }, signal?: AbortSignal): Promise<SlackPostResult> {
    const destination = input.to;
    const messageBody = slackMessageBody(input.text, {
      plainText: input.plain_text,
    });
    const threadTs = destination.thread_ts?.trim() || undefined;
    const payload = await this.call(
      "chat.postMessage",
      {
        channel: destination.channel,
        text: messageBody.text,
        blocks: messageBody.blocks,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      },
      "json",
      signal,
    );
    const channel = payload.channel || destination.channel;
    const ts = payload.ts;
    if (!ts)
      throw new Error("Slack chat.postMessage returned no message timestamp");
    const postedThread = payload.message?.thread_ts || threadTs || ts;

    if (input.record_bridge === false) {
      return { ok: true, channel, ts, thread_ts: postedThread, bridge_recorded: false };
    }

    try {
      const bridgeRecorded = await this.recordPostedMessage(
        {
          provider: "slack",
          ...(input.mode === "send" ? { mode: "send" as const } : {}),
          channel,
          ts,
          thread_ts: postedThread,
        },
        signal,
      );
      return {
        ok: true,
        channel,
        ts,
        thread_ts: postedThread,
        bridge_recorded: bridgeRecorded,
      };
    } catch (error) {
      return {
        ok: true,
        channel,
        ts,
        thread_ts: postedThread,
        bridge_recorded: false,
        bridge_error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async recordPostedMessage(data: {
    provider: "slack";
    mode?: "send" | "reply";
    channel: string;
    ts: string;
    thread_ts: string;
  }, signal?: AbortSignal): Promise<boolean> {
    // Only bookkeeping is retried. The confirmed Slack post above must never
    // be repeated because the platform registration is temporarily unavailable.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.recordPostedMessageOnce(data, signal);
      } catch (error) {
        if (attempt >= 2 || signal?.aborted ||
            (error instanceof SlackBridgeError && !error.retryable)) throw error;
        await setTimeout(100 * (attempt + 1), undefined, { signal });
      }
    }
  }

  private async recordPostedMessageOnce(data: {
    provider: "slack";
    channel: string;
    ts: string;
    thread_ts: string;
  }, signal?: AbortSignal): Promise<boolean> {
    const baseUrl = this.env.INTROSPECTION_BASE_API_URL?.trim();
    const taskId = this.env.INTROSPECTION_TASK_ID?.trim();
    const token = this.env.INTROSPECTION_TOKEN?.trim();
    if (!configured(baseUrl) || !configured(taskId) || !configured(token)) {
      return false;
    }
    const runId =
      this.env.INTROSPECTION_TASK_RUN_ID?.trim() ||
      this.env.INTROSPECTION_TASK_CONVERSATION_ID?.trim();
    const response = await this.fetchImpl(
      `${baseUrl.replace(/\/$/, "")}/internal/tasks/${taskId}/events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "connector_posted",
          run_id: runId || undefined,
          occurred_at: new Date().toISOString(),
          data,
        }),
        signal,
      },
    );
    if (!response.ok) {
      throw new SlackBridgeError(
        `connector_posted returned HTTP ${response.status}`,
        response.status >= 500 || response.status === 429,
      );
    }
    const payload = await response.json() as { result?: { recorded?: boolean; skipped?: string } };
    if (payload.result?.skipped) {
      throw new SlackBridgeError(`Reply routing was not confirmed: ${payload.result.skipped}`, true);
    }
    return payload.result?.recorded === true;
  }
}

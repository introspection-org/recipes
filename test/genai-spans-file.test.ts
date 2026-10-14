/**
 * `PI_RECIPE_GENAI_SPANS_FILE`: a standalone Pi run keeps its GenAI span list
 * in a file, current after every turn.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { piSessionToSpans } from "@introspection-sdk/introspection-pi";
import { registerGenAiSpansFile } from "../src/genai-spans-file.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

const header = {
  type: "session",
  version: 3,
  id: "session-1",
  timestamp: "2026-10-13T10:00:00.000Z",
  cwd: "/workspace",
};

function message(id: string, parentId: string | null, body: Record<string, unknown>) {
  return { type: "message", id, parentId, timestamp: "2026-10-13T10:00:01.000Z", message: body };
}

const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const prompt = message("e1", null, {
  role: "user",
  content: [{ type: "text", text: "List the files." }],
  timestamp: 1,
});
const call = message("e2", "e1", {
  role: "assistant",
  content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
  api: "openai-responses",
  provider: "openai",
  model: "gpt-4.1",
  usage,
  stopReason: "toolUse",
  timestamp: 2,
});
const result = message("e3", "e2", {
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "bash",
  content: [{ type: "text", text: "a.txt" }],
  isError: false,
  timestamp: 3,
});

function context(entries: unknown[], sessionHeader: unknown = header) {
  return {
    sessionManager: {
      getHeader: () => sessionHeader,
      getEntries: () => entries,
      getSessionId: () => "session-1",
    },
  } as any;
}

describe("PI_RECIPE_GENAI_SPANS_FILE", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "genai-spans-"));
    path = join(dir, "logs", "genai-spans.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const read = () => JSON.parse(readFileSync(path, "utf8"));

  it("registers nothing unless the variable names a file", () => {
    const pi = createMockExtensionAPI();
    registerGenAiSpansFile(pi, {});
    registerGenAiSpansFile(pi, { PI_RECIPE_GENAI_SPANS_FILE: " " });
    expect(pi.handlers.size).toBe(0);
  });

  it("writes an empty span list when the session starts, then each finished turn", async () => {
    const pi = createMockExtensionAPI();
    registerGenAiSpansFile(pi, { PI_RECIPE_GENAI_SPANS_FILE: path });
    const entries: unknown[] = [];
    const ctx = context(entries);

    await pi.emitExtensionEvent({ type: "session_start" } as any, ctx);
    expect(read().data).toEqual([]);

    entries.push(prompt, call, result);
    await pi.emitExtensionEvent({ type: "turn_end" } as any, ctx);
    expect(read().data.map((span: { name: string }) => span.name)).toEqual([
      "chat gpt-4.1",
      "execute_tool bash",
    ]);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("writes what pi-session-spans renders from the session file", async () => {
    const pi = createMockExtensionAPI();
    registerGenAiSpansFile(pi, { PI_RECIPE_GENAI_SPANS_FILE: path });
    const entries = [prompt, call, result];

    await pi.emitExtensionEvent({ type: "agent_end" } as any, context(entries));

    const file = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n");
    expect(read()).toEqual(JSON.parse(JSON.stringify(piSessionToSpans(file, "session-1"))));
  });

  it("leaves the run alone when the session cannot be rendered", async () => {
    const pi = createMockExtensionAPI();
    registerGenAiSpansFile(pi, { PI_RECIPE_GENAI_SPANS_FILE: path });

    await pi.emitExtensionEvent({ type: "turn_end" } as any, context([], null));
    await pi.emitExtensionEvent({ type: "turn_end" } as any, context([], { type: "other" }));

    expect(existsSync(path)).toBe(false);
  });
});

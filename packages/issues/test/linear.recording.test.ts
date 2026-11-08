import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { type RecipeSessionHandle } from "../../../src/session.js";
import { writeFixtureRecipe } from "../../../src/test-utils.js";
import {
  lastToolResult,
  openRecipeSession,
} from "../../../test/helpers/mcp-session.js";
import {
  hasRecording,
  RECORDING,
  recordingToken,
  startMcpRecording,
} from "../../../test/helpers/polly.js";

/**
 * Pi's MCP client against Linear's MCP server, read-only: search, get, then
 * the first search again, once through the `issues` tool and once in code
 * mode with Linear's tools in view. Records with `POLLY_MODE=record` and
 * `MCP_RECORD_TOKEN_FILE` (a `connectors connections token -o json` answer);
 * replays the committed cassettes otherwise. `<name>.summary.json` beside each
 * cassette is what the model was handed per turn and the MCP calls behind it.
 */
const DIR =
  process.env.MCP_RECORDINGS_DIR ?? join(import.meta.dirname, "recordings");
// The dummy issue the recording reads (INT-598), under the test label, so a
// search can only ever reach test issues.
const QUERY = "recipe test issue";
const LABEL = "ws: cloud-testing";
const MCP_URL = "https://mcp.linear.app/mcp";
const ISSUES_MODULE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "src",
  "issues",
  "index.ts",
);
const PROVIDERS_MODULE = join(import.meta.dirname, "..", "src", "index.ts");

type Context = Parameters<
  Extract<FauxResponseStep, (...args: never[]) => unknown>
>[0];

interface Turn {
  step: string;
  systemPromptBytes: number;
  toolsBytes: number;
  tools: string[];
  lastToolResultBytes: number;
  mcpCallsSinceLastTurn: string[];
}

/** What the model is handed: the prompt and tool declarations, carried by the system messages. */
function modelView(context: Context) {
  const system = (
    context.messages as unknown as Array<{
      role: string;
      content: string | Array<{ text?: string }>;
      sections?: Record<string, string | null>;
      toolsAdded?: Array<{
        name: string;
        description?: string;
        parameters?: unknown;
      }>;
    }>
  ).filter((message) => message.role === "system");
  const prompt = system
    .map((message) =>
      [
        typeof message.content === "string"
          ? message.content
          : message.content.map((part) => part.text ?? "").join(""),
        ...Object.values(message.sections ?? {}).filter((s): s is string =>
          Boolean(s),
        ),
      ].join("\n"),
    )
    .join("\n");
  const tools = system.flatMap((message) => message.toolsAdded ?? []);
  return { prompt, tools };
}

function recorder(calls: readonly string[]) {
  const turns: Turn[] = [];
  const transcript: unknown[] = [];
  let seen = 0;
  return {
    turns,
    transcript,
    turn(step: string, context: Context) {
      const { prompt, tools } = modelView(context);
      const result = lastToolResult(context);
      const mcp = calls.slice(seen);
      turns.push({
        step,
        systemPromptBytes: Buffer.byteLength(prompt),
        toolsBytes: Buffer.byteLength(JSON.stringify(tools)),
        tools: tools.map((tool) => tool.name),
        lastToolResultBytes: Buffer.byteLength(result),
        mcpCallsSinceLastTurn: mcp,
      });
      transcript.push({
        step,
        ...(transcript.length === 0 ? { prompt, tools } : {}),
        result,
        mcp,
      });
      seen = calls.length;
    },
  };
}

/** The model's full view, for a person to read; never committed (it holds the workspace's data). */
function writeTranscript(name: string, transcript: unknown) {
  const dir = process.env.MCP_TRANSCRIPT_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.transcript.json`),
    `${JSON.stringify(transcript, null, 2)}\n`,
  );
}

/** Written when recording: a replay's sizes are the anonymized examples', not the server's. */
function writeSummary(name: string, summary: unknown) {
  if (!RECORDING) return;
  mkdirSync(DIR, { recursive: true });
  writeFileSync(
    join(DIR, `${name}.summary.json`),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
}

const call = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

describe("Linear over its MCP server (recorded)", () => {
  const handles: RecipeSessionHandle[] = [];
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const handle of handles.splice(0))
      await handle.dispose().catch(() => {});
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function open(
    name: string,
    mode: "tools" | "codemode",
    behind: boolean,
    responses: (calls: readonly string[]) => FauxResponseStep[],
  ) {
    const { polly, calls } = startMcpRecording(name, DIR, "mcp.linear.app");
    cleanups.push(() => polly.stop());
    const fixture = writeFixtureRecipe({
      tools: behind ? ["read", "issues"] : ["read"],
      manifestPi: {
        ...(behind ? { extensions: ["extensions/*.ts"] } : {}),
        mcp: {
          servers: [
            { id: "linear", required: true, tools: { include: ["*"] } },
          ],
        },
      },
      agentExtras: [
        "mcp:",
        `  mode: ${mode}`,
        "  servers:",
        "    linear:",
        '      include: ["*"]',
        ...(behind ? ["      behind: [issues]"] : []),
      ],
    });
    cleanups.push(fixture.cleanup);
    if (behind) {
      mkdirSync(join(fixture.recipeDir, "extensions"));
      writeFileSync(
        join(fixture.recipeDir, "extensions", "issues.ts"),
        [
          `import { registerIssuesTool } from ${JSON.stringify(ISSUES_MODULE)};`,
          `import { linearIssuesProvider } from ${JSON.stringify(PROVIDERS_MODULE)};`,
          "export default (pi) => {",
          "  registerIssuesTool(pi, { providers: [{ module: linearIssuesProvider, config: { provider: 'linear', options: {} }, server: 'linear', fallback: false }] });",
          "};",
          "",
        ].join("\n"),
      );
    }
    const handle = await openRecipeSession({
      ...fixture,
      responses: responses(calls),
      bindings: [
        {
          id: "linear",
          url: MCP_URL,
          headers: { Authorization: `Bearer ${recordingToken()}` },
        },
      ],
    });
    handles.push(handle);
    return { handle, polly };
  }

  it.skipIf(!RECORDING && !hasRecording(DIR, "issues-tool"))(
    "the issues tool: search, get, then the same search again",
    async () => {
      let rec: ReturnType<typeof recorder> | undefined;
      let handle = "";
      const search = {
        command: "search",
        query: QUERY,
        label: LABEL,
        limit: 5,
      };
      const { handle: session, polly } = await open(
        "issues-tool",
        "tools",
        true,
        (p) => {
          rec = recorder(p);
          return [
            (context) => (rec!.turn("start", context), call("issues", search)),
            (context) => {
              rec!.turn("search", context);
              handle =
                /^(linear:\S+)/m.exec(lastToolResult(context))?.[1] ?? "";
              return handle
                ? call("issues", { command: "get", handle })
                : fauxAssistantMessage("no issues");
            },
            (context) => (rec!.turn("get", context), call("issues", search)),
            (context) => (
              rec!.turn("search again", context),
              fauxAssistantMessage("done")
            ),
          ];
        },
      );

      await session.session.prompt("go");
      await polly.stop();

      writeSummary("issues-tool", { turns: rec!.turns });
      writeTranscript("issues-tool", rec!.transcript);
      const listCalls = rec!.turns
        .flatMap((turn) => turn.mcpCallsSinceLastTurn)
        .filter((c) => c === "tools/call list_issues");
      expect(listCalls).toHaveLength(2);
      expect(rec!.turns.at(-1)!.mcpCallsSinceLastTurn).toEqual([
        "tools/call list_issues",
      ]);
    },
  );

  it.skipIf(!RECORDING && !hasRecording(DIR, "codemode"))(
    "code mode with Linear's tools in reach: discover, search, get, then the same search again",
    async () => {
      let rec: ReturnType<typeof recorder> | undefined;
      let list = "";
      let get = "";
      const listArgs = JSON.stringify({ query: QUERY, label: LABEL, limit: 5 });
      const { handle: session, polly } = await open(
        "codemode",
        "codemode",
        false,
        (p) => {
          rec = recorder(p);
          const script = (code: string) => call("codemode", { code });
          const named = (result: string, tool: string) =>
            new RegExp(`\\b(\\w*linear\\w*${tool})\\b`).exec(result)?.[1] ?? "";
          return [
            // A model knows only that a Linear server exists: it searches the
            // client's catalog for the tools, then reads the one it will call.
            (context) => (
              rec!.turn("start", context),
              script(`return await searchTools("list issues", { limit: 20 });`)
            ),
            (context) => {
              rec!.turn("searchTools", context);
              list = named(lastToolResult(context), "list_issues");
              get = named(lastToolResult(context), "get_issue");
              return script(
                `return await describeTool(${JSON.stringify(list)});`,
              );
            },
            (context) => (
              rec!.turn("describeTool", context),
              script(`return await tools.${list}(${listArgs});`)
            ),
            (context) => {
              rec!.turn("search", context);
              const id = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/.exec(
                lastToolResult(context),
              )?.[1];
              return id
                ? script(
                    `return await tools.${get || list.replace("list_issues", "get_issue")}({ id: ${JSON.stringify(id)} });`,
                  )
                : fauxAssistantMessage("no issues");
            },
            (context) => (
              rec!.turn("get", context),
              script(`return await tools.${list}(${listArgs});`)
            ),
            (context) => (
              rec!.turn("search again", context),
              fauxAssistantMessage("done")
            ),
          ];
        },
      );

      await session.session.prompt("go");
      await polly.stop();

      writeSummary("codemode", { turns: rec!.turns });
      writeTranscript("codemode", rec!.transcript);
      expect(rec!.turns.map((turn) => turn.step)).toEqual([
        "start",
        "searchTools",
        "describeTool",
        "search",
        "get",
        "search again",
      ]);
      expect(rec!.turns.at(-1)!.mcpCallsSinceLastTurn).toEqual([
        "tools/call list_issues",
      ]);
    },
  );
});

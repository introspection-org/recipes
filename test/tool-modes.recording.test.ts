import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { resolveRecipe } from "../src/recipe/resolve.js";
import {
  createAgentSession,
  type RecipeSessionHandle,
} from "../src/session.js";
import { cleanEnv } from "../src/test-utils.js";
import {
  hasRecording,
  RECORDING,
  recordedRequests,
  startModelRecording,
} from "./helpers/polly.js";
import {
  googleToolModeRecipe,
  TOOL_MODES,
  type ToolMode,
} from "./helpers/tool-modes.js";

/**
 * One prompt needing Google's mail, calendar and drive, run through a real
 * Anthropic model once per first-party tool mode, so the cassettes carry
 * what each mode costs in tokens, under a folder per model. Records with
 * `POLLY_MODE=record` and `ANTHROPIC_API_KEY`, one model at a time
 * (`RECORD_MODEL`, default the cheapest) into one set (`RECORD_SET`, default
 * the newest) and optionally one mode
 * (`RECORD_MODE`); replays every committed cassette otherwise.
 * `<mode>.summary.json` beside each is Anthropic's `usage` per request and
 * the tool calls the model made; `tool-modes.test.ts` is the model-free
 * baseline.
 */
const DIR = join(import.meta.dirname, "recordings", "tool-modes");
// Each model's provider, the host its calls go to and the key a recording sends.
const PROVIDERS = {
  anthropic: { host: "api.anthropic.com", key: "ANTHROPIC_API_KEY" },
  openai: { host: "api.openai.com", key: "OPENAI_API_KEY" },
} as const;
type Provider = keyof typeof PROVIDERS;
const MODELS: ReadonlyArray<{ id: string; provider: Provider }> = [
  { id: "claude-haiku-5-5", provider: "anthropic" },
  { id: "claude-sonnet-5-5", provider: "anthropic" },
  { id: "claude-opus-5-5", provider: "anthropic" },
  { id: "gpt-6-luna", provider: "openai" },
  { id: "gpt-6.1-sol", provider: "openai" },
  { id: "gpt-6-astra", provider: "openai" },
];
const RECORD_MODEL = process.env.RECORD_MODEL ?? MODELS[0]!.id;
// What the tools told the model when a set was recorded: `flat`, before each
// command's signature was in its description; `signatures`, after.
// The fixture runs at low effort; a `-<effort>` set records the same at another.
// `signatures-clock`, with the fixture's data dated in the clock's own zone;
// `signatures-shape`, that and calendar.list and reply drafts needing less.
const SETS = [
  "flat",
  "signatures",
  "signatures-medium",
  "signatures-high",
  "signatures-clock",
  "signatures-shape",
] as const;
const EFFORTS = ["low", "medium", "high"];
const effortOf = (set: string) =>
  set.split("-").find((part) => EFFORTS.includes(part)) ?? "low";
const RECORD_SET = process.env.RECORD_SET ?? "signatures";
// Trials per mode: one run is noise. Run 1 is `<mode>`, later runs `<mode>.<n>`.
const RECORD_RUNS = Number(process.env.RECORD_RUNS ?? 1);
// The first run to record, so more trials add to a cell rather than replace it.
const RECORD_FROM = Number(process.env.RECORD_FROM ?? 1);
const MAX_RUNS = 10;
const RECORD_MODE = process.env.RECORD_MODE;
const PROMPT =
  "What's on my calendar tomorrow, and did Dana email about the budget? " +
  "Find the budget spreadsheet in my Drive, then draft a reply to Dana saying " +
  "I'll bring it to the meeting, with a link to the sheet. Don't send it.";
const REPO = join(import.meta.dirname, "..");

interface Usage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

interface RequestSummary extends Usage {
  stop_reason?: string;
  tool_calls: Array<{ name: string; input: unknown }>;
}

interface Summary {
  model: string;
  prompt: string;
  requests: RequestSummary[];
  totals: Usage & { requests: number; tool_calls: number };
}

const USAGE_FIELDS = [
  "input_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "output_tokens",
] as const;

/**
 * One streamed OpenAI Responses response: `usage` and the function calls from
 * `response.completed`. Cached input is what it read from the cache; OpenAI
 * charges nothing extra to write one.
 */
function summarizeOpenAiResponse(body: string): RequestSummary {
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const event = JSON.parse(line.slice(5)) as {
      type: string;
      response?: {
        status?: string;
        usage?: {
          input_tokens?: number;
          input_tokens_details?: { cached_tokens?: number };
          output_tokens?: number;
        };
        output?: Array<{
          type: string;
          name?: string;
          arguments?: string;
          input?: string;
        }>;
      };
    };
    if (event.type !== "response.completed" || !event.response) continue;
    const usage = event.response.usage ?? {};
    const cached = usage.input_tokens_details?.cached_tokens ?? 0;
    return {
      input_tokens: (usage.input_tokens ?? 0) - cached,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cached,
      output_tokens: usage.output_tokens ?? 0,
      ...(event.response.status ? { stop_reason: event.response.status } : {}),
      // A free-form tool such as codemode is a `custom_tool_call`, its input text.
      tool_calls: (event.response.output ?? [])
        .filter(
          (item) =>
            item.type === "function_call" || item.type === "custom_tool_call",
        )
        .map((item) => ({
          name: item.name ?? "",
          input:
            item.type === "custom_tool_call"
              ? (item.input ?? "")
              : item.arguments
                ? (JSON.parse(item.arguments) as unknown)
                : {},
        })),
    };
  }
  throw new Error("An OpenAI response without response.completed");
}

/** One streamed Messages response: `usage` from `message_start` and `message_delta`, and its `tool_use` blocks. */
function summarizeResponse(body: string): RequestSummary {
  const usage: Usage = {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };
  const merge = (from: Partial<Usage> | undefined) => {
    for (const field of USAGE_FIELDS)
      if (typeof from?.[field] === "number") usage[field] = from[field];
  };
  const blocks = new Map<number, { name: string; json: string }>();
  let stop_reason: string | undefined;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const event = JSON.parse(line.slice(5)) as {
      type: string;
      index?: number;
      message?: { usage?: Partial<Usage> };
      usage?: Partial<Usage>;
      delta?: { stop_reason?: string; type?: string; partial_json?: string };
      content_block?: { type: string; name?: string };
    };
    if (event.type === "message_start") merge(event.message?.usage);
    if (event.type === "message_delta") {
      merge(event.usage);
      stop_reason = event.delta?.stop_reason ?? stop_reason;
    }
    if (
      event.type === "content_block_start" &&
      event.content_block?.type === "tool_use"
    )
      blocks.set(event.index!, { name: event.content_block.name!, json: "" });
    if (
      event.type === "content_block_delta" &&
      event.delta?.type === "input_json_delta"
    )
      blocks.get(event.index!)!.json += event.delta.partial_json ?? "";
  }
  return {
    ...usage,
    ...(stop_reason ? { stop_reason } : {}),
    tool_calls: [...blocks.values()].map(({ name, json }) => ({
      name,
      input: json ? (JSON.parse(json) as unknown) : {},
    })),
  };
}

function summarize(
  responses: readonly string[],
  model: { id: string; provider: Provider },
): Summary {
  const requests = responses.map(
    model.provider === "openai" ? summarizeOpenAiResponse : summarizeResponse,
  );
  const sum = (field: (typeof USAGE_FIELDS)[number]) =>
    requests.reduce((total, request) => total + request[field], 0);
  return {
    model: `${model.provider}/${model.id}`,
    prompt: PROMPT,
    requests,
    totals: {
      requests: requests.length,
      tool_calls: requests.reduce((n, r) => n + r.tool_calls.length, 0),
      input_tokens: sum("input_tokens"),
      cache_creation_input_tokens: sum("cache_creation_input_tokens"),
      cache_read_input_tokens: sum("cache_read_input_tokens"),
      output_tokens: sum("output_tokens"),
    },
  };
}

/** The live key when recording, never printed or written; a placeholder a replay never sends. */
function providerKey(provider: Provider, record: boolean): string {
  if (!record) return "replay";
  const name = PROVIDERS[provider].key;
  const key = process.env[name];
  if (!key) throw new Error(`Recording ${provider} needs ${name}`);
  return key;
}

/** Local paths a request names (the run's temp dirs, the repository), as placeholders. */
function localPaths(): Array<[string, string]> {
  const paths: Array<[string, string]> = [
    [REPO, "/repo"],
    [realpathSync(REPO), "/repo"],
    [realpathSync(tmpdir()), "/tmp"],
    [tmpdir(), "/tmp"],
    [homedir(), "/home/user"],
    // A shell listing names the file owner on its own, outside any path.
    [userInfo().username, "user"],
  ];
  return paths.sort(([a], [b]) => b.length - a.length);
}

describe("Google tools per tool mode, on a real model (recorded)", () => {
  const handles: RecipeSessionHandle[] = [];
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const handle of handles.splice(0))
      await handle.dispose().catch(() => {});
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  for (const set of SETS)
    for (const model of MODELS)
      for (const mode of Object.keys(TOOL_MODES) as ToolMode[])
        for (let run = 1; run <= MAX_RUNS; run++) {
          const dir = join(DIR, set, model.id);
          const name = run === 1 ? mode : `${mode}.${run}`;
          const record =
            RECORDING &&
            set === RECORD_SET &&
            model.id === RECORD_MODEL &&
            run >= RECORD_FROM &&
            run <= RECORD_RUNS &&
            (RECORD_MODE === undefined || RECORD_MODE === mode);
          if (!record && !hasRecording(dir, name)) continue;
          it(`${set} ${model.id} ${name}: calendar, mail and drive, then a draft`, async () => {
            const { polly, responses } = startModelRecording(
              name,
              dir,
              PROVIDERS[model.provider].host,
              localPaths(),
              record,
            );
            cleanups.push(() => polly.stop());
            const fixture = googleToolModeRecipe(mode);
            cleanups.push(fixture.cleanup);
            const agentPath = join(fixture.recipeDir, "agents", "agent.yaml");
            writeFileSync(
              agentPath,
              readFileSync(agentPath, "utf8")
                .replace(
                  "anthropic/claude-sonnet-4-5",
                  `${model.provider}/${model.id}`,
                )
                .replace(
                  "thinking_level: low",
                  `thinking_level: ${effortOf(set)}`,
                ),
            );
            const credentials = new InMemoryCredentialStore();
            await credentials.modify(model.provider, async () => ({
              type: "api_key",
              key: providerKey(model.provider, record),
            }));
            const handle = await createAgentSession({
              recipe: resolveRecipe({ recipeDir: fixture.recipeDir }),
              cwd: fixture.workspaceDir,
              env: cleanEnv(),
              credentials,
              mcpBindings: { servers: [] },
            });
            handles.push(handle);

            await handle.session.prompt(PROMPT);
            await polly.stop();

            const summary = summarize(responses, model);
            const path = join(dir, `${name}.summary.json`);
            // UPDATE_SUMMARIES rewrites a summary from its cassette, when how one is read changes.
            if (record || process.env.UPDATE_SUMMARIES) {
              mkdirSync(dir, { recursive: true });
              writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`);
            } else {
              const committed = JSON.parse(
                readFileSync(path, "utf8"),
              ) as Summary;
              expect(committed.requests).toHaveLength(
                recordedRequests(dir, name),
              );
              expect(summary).toEqual(committed);
            }
            expect(summary.totals.tool_calls).toBeGreaterThan(0);
          }, 600_000);
        }
});

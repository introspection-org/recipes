import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"] as const;
const RECORD_MODEL = process.env.RECORD_MODEL ?? MODELS[0];
// What the tools told the model when a set was recorded: `flat`, before each
// command's signature was in its description; `signatures`, after.
const SETS = ["flat", "signatures"] as const;
const RECORD_SET = process.env.RECORD_SET ?? SETS.at(-1);
// Trials per mode: one run is noise. Run 1 is `<mode>`, later runs `<mode>.<n>`.
const RECORD_RUNS = Number(process.env.RECORD_RUNS ?? 1);
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

function summarize(responses: readonly string[], model: string): Summary {
  const requests = responses.map(summarizeResponse);
  const sum = (field: (typeof USAGE_FIELDS)[number]) =>
    requests.reduce((total, request) => total + request[field], 0);
  return {
    model: `anthropic/${model}`,
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
function anthropicKey(record: boolean): string {
  if (!record) return "replay";
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("POLLY_MODE=record needs ANTHROPIC_API_KEY");
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
          const dir = join(DIR, set, model);
          const name = run === 1 ? mode : `${mode}.${run}`;
          const record =
            RECORDING &&
            set === RECORD_SET &&
            model === RECORD_MODEL &&
            run <= RECORD_RUNS &&
            (RECORD_MODE === undefined || RECORD_MODE === mode);
          if (!record && !hasRecording(dir, name)) continue;
          it(`${set} ${model} ${name}: calendar, mail and drive, then a draft`, async () => {
            const { polly, responses } = startModelRecording(
              name,
              dir,
              "api.anthropic.com",
              localPaths(),
              record,
            );
            cleanups.push(() => polly.stop());
            const fixture = googleToolModeRecipe(mode);
            cleanups.push(fixture.cleanup);
            const agentPath = join(fixture.recipeDir, "agents", "agent.yaml");
            writeFileSync(
              agentPath,
              readFileSync(agentPath, "utf8").replace(
                "anthropic/claude-sonnet-4-5",
                `anthropic/${model}`,
              ),
            );
            const credentials = new InMemoryCredentialStore();
            await credentials.modify("anthropic", async () => ({
              type: "api_key",
              key: anthropicKey(record),
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
            if (record) {
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

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRunSummary } from "../src/agents.js";
import type { BatchRunController } from "../src/batch/index.js";
import {
  completeClassifierVerdict,
  completeLlmVerdict,
  createJudgeRunController,
  evaluateGate,
  evidenceHash,
  gateView,
  judgementId,
  loadJudges,
  normalizeReplayTrajectory,
  parseJudgeDefinition,
  renderTrajectoryInput,
  runJudges,
  samplesIn,
  toJudgeInput,
  trajectoryFromPiSession,
  type JudgeClassifier,
  type JudgeInputLine,
} from "../src/judges/index.js";
import { judgeCli, parseJudgeCliArgs } from "../src/judges/cli-main.js";
import { stripCodeFence } from "../src/judges/verdict.js";
import { resolveRecipe } from "../src/recipe/resolve.js";
import { createAgentSessionInternal } from "../src/session.js";
import { cleanEnv, writeFixtureRecipe } from "../src/test-utils.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const LLM_JUDGE = [
  "name: greeting",
  "on:",
  "  - event: tool",
  "    match:",
  "      name: /echo$/",
  "ai:",
  "  model: faux/faux-1",
  "  fallbacks: [faux-b/faux-b-1]",
  "instructions: Did the assistant echo the message?",
  "",
].join("\n");

const CLASSIFIER_JUDGE = [
  "name: polite",
  "ai:",
  "  model: typesafe/jev-latest",
  "  fallbacks: [openai/gpt-6-luna]",
  "questions:",
  "  greeted:",
  "    instructions: Did the assistant greet the user?",
  "    criteria:",
  "      true: The first reply opens with a greeting.",
  "      false: It does not.",
  "    threshold: 0.8",
  "  apologised:",
  "    instructions: Did the assistant apologise?",
  "    criteria:",
  "      true: It says sorry.",
  "      false: It does not.",
  "",
].join("\n");

/** A trajectory export: the assistant calls an echo tool and reports its result. */
const EXPORT = [
  { role: "meta", source: "test", model: "faux/faux-1" },
  { role: "user", content: "say hello", timestamp: "2026-01-01T00:00:00Z" },
  {
    role: "assistant",
    content: null,
    timestamp: "2026-01-01T00:00:01Z",
    tool_calls: [
      { id: "c1", name: "mcp_hello_echo", args: '{"message":"hello"}' },
    ],
  },
  {
    role: "tool",
    tool_call_id: "c1",
    content: "Echo: hello",
    timestamp: "2026-01-01T00:00:02Z",
    ok: true,
  },
  { role: "assistant", content: "Done.", timestamp: "2026-01-01T00:00:03Z" },
];

const SMALL_TALK = [
  { role: "user", content: "hi there", timestamp: "2026-01-01T00:00:00Z" },
  { role: "assistant", content: "Hello!", timestamp: "2026-01-01T00:00:01Z" },
];

function line(custom_id: string, trajectory: unknown[]): JudgeInputLine {
  return { custom_id, trajectory };
}

function summary(patch: Partial<AgentRunSummary>): AgentRunSummary {
  return {
    agent_run_id: "run",
    invocation_name: "judge",
    agent_name: "judge",
    label: "",
    prompt: "",
    status: "running",
    started_at: 0,
    last_activity_at: 0,
    ...patch,
  };
}

/** A controller that answers every prompt with `reply(name, prompt)`, counting its starts. */
function scripted(reply: (name: string, prompt: string) => string) {
  const runs = new Map<string, AgentRunSummary>();
  const started: string[] = [];
  const controller: BatchRunController = {
    async start(input) {
      const id = `run-${runs.size + 1}`;
      started.push(`${input.name}:${input.label}`);
      const run = summary({
        agent_run_id: id,
        agent_name: input.name,
        status: "completed",
        output: reply(input.name, input.prompt),
      });
      runs.set(id, run);
      return run;
    },
    wait: async (id) => runs.get(id)!,
    message: async (id) => runs.get(id)!,
    close: async (id) => ({ ...runs.get(id)!, status: "closed" }),
  };
  return { controller, started };
}

describe("judge definitions", () => {
  it("reads an LLM judge with the agent ai block", () => {
    const judge = parseJudgeDefinition("judges/greeting.yaml", LLM_JUDGE);
    expect(judge).toMatchObject({
      kind: "llm",
      name: "greeting",
      ai: { name: "faux/faux-1", fallbacks: ["faux-b/faux-b-1"] },
    });
    expect(judge?.definitionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reads a classifier judge with a threshold per question, 0.5 by default", () => {
    const judge = parseJudgeDefinition("judges/polite.yaml", CLASSIFIER_JUDGE);
    expect(judge).toMatchObject({
      kind: "classifier",
      questions: {
        greeted: { threshold: 0.8 },
        apologised: { threshold: 0.5 },
      },
    });
  });

  it("reads the older llm block as the ai block recipe-check maps it to", () => {
    const warnings: string[] = [];
    const judge = parseJudgeDefinition(
      "judges/old.yaml",
      "name: old\nllm:\n  provider: anthropic\n  model: claude-sonnet-5-5\n  request:\n    max_tokens: 512\n    reasoning_effort: low\n  local:\n    base_url: http://localhost:8080\n    api_key_env: LOCAL_KEY\ninstructions: x\n",
      { onWarning: (warning) => warnings.push(warning) },
    );
    expect(judge).toMatchObject({
      kind: "llm",
      ai: {
        name: "anthropic/claude-sonnet-5-5",
        thinkingLevel: "low",
      },
    });
    expect(warnings).toEqual([expect.stringContaining("llm.local")]);
  });

  it("refuses a gate regex JavaScript cannot compile", () => {
    expect(() =>
      parseJudgeDefinition(
        "judges/gate.yaml",
        "name: gate\nai:\n  model: faux/faux-1\ninstructions: x\non:\n  - event: message\n    match:\n      text: '/(?P<word>a)/'\n",
      ),
    ).toThrow(/JavaScript regex/);
  });

  it("reads a gate regex only the u flag compiles", () => {
    const judge = parseJudgeDefinition(
      "judges/gate.yaml",
      "name: gate\nai:\n  model: faux/faux-1\ninstructions: x\non:\n  - event: message\n    match:\n      text: '/[\\w-]+@acme/'\n",
    );
    expect(judge?.on).toEqual([
      { event: "message", match: { text: "/[\\w-]+@acme/" } },
    ]);
  });

  it("names the binary when recipe-check cannot be run", () => {
    expect(() =>
      parseJudgeDefinition("judges/greeting.yaml", LLM_JUDGE, {
        recipeCheck: "/nonexistent/introspection-recipe-check",
      }),
    ).toThrow(/INTROSPECTION_RECIPE_CHECK/);
  });

  it("refuses a judge with both instructions and questions, or neither", () => {
    expect(() =>
      parseJudgeDefinition(
        "judges/none.yaml",
        "name: none\nai:\n  model: faux/faux-1\n",
      ),
    ).toThrow(/either `instructions`.*or `questions`/);
  });

  it("refuses a gate on where the judge runs", () => {
    expect(() =>
      parseJudgeDefinition(
        "judges/env.yaml",
        "name: env\nai:\n  model: faux/faux-1\ninstructions: x\non:\n  - event: message\n    match:\n      environment: production\n",
      ),
    ).toThrow(/automatic platform context/);
  });

  it("skips a mission judge and loads the rest of judges/ by file order", () => {
    const fixture = writeFixtureRecipe();
    cleanups.push(fixture.cleanup);
    const directory = join(fixture.recipeDir, "judges");
    mkdirSync(directory);
    writeFileSync(join(directory, "b-greeting.yaml"), LLM_JUDGE);
    writeFileSync(join(directory, "a-polite.yaml"), CLASSIFIER_JUDGE);
    writeFileSync(join(directory, "mission.yaml"), "type: mission\nname: m\n");
    writeFileSync(join(directory, "greeting.eval.jsonl"), "{}\n");
    expect(loadJudges(fixture.recipeDir).map((judge) => judge.name)).toEqual([
      "polite",
      "greeting",
    ]);
  });
});

describe("judge gate", () => {
  const view = gateView(toJudgeInput(EXPORT, "Be brief."));
  const applies = (on: unknown) => evaluateGate(on, view);

  it("always applies with no gate", () => {
    expect(applies(undefined)).toBe(true);
    expect(applies([])).toBe(true);
  });

  it("matches exact fields exactly and text fields by substring", () => {
    expect(
      applies([{ event: "tool", match: { name: "mcp_hello_echo" } }]),
    ).toBe(true);
    expect(applies([{ event: "tool", match: { name: "mcp_hello" } }])).toBe(
      false,
    );
    expect(applies([{ event: "message", match: { text: "SAY HEL" } }])).toBe(
      true,
    );
    expect(
      applies([{ event: "tool", match: { "args.message": "HELLO" } }]),
    ).toBe(true);
  });

  it("matches regex literals, a list as any-of, and every field of one matcher", () => {
    expect(applies([{ event: "tool", match: { name: "/^MCP_/i" } }])).toBe(
      true,
    );
    expect(
      applies([{ event: "message", match: { role: ["tool", "system"] } }]),
    ).toBe(true);
    expect(
      applies([{ event: "tool", match: { name: "/echo$/", status: "error" } }]),
    ).toBe(false);
    expect(applies([{ event: "tool", match: { result: "/^Echo/" } }])).toBe(
      true,
    );
  });

  it("falls back to the u flag for a pattern the v flag refuses", () => {
    expect(
      applies([{ event: "tool", match: { name: "/^[\\w-]+_echo$/" } }]),
    ).toBe(true);
    expect(applies([{ event: "tool", match: { name: "/^[a-z-]+$/" } }])).toBe(
      false,
    );
  });

  it("refuses a pattern it cannot read rather than matching it as something else", () => {
    expect(() =>
      applies([{ event: "tool", match: { name: "/^[a-z_&&[^0-9]]+$/" } }]),
    ).toThrow(/invalid regex/);
    expect(() => applies([{ event: "tool", match: { name: "/x/g" } }])).toThrow(
      /unsupported regex flags/,
    );
  });

  it("does not count a tool call that never returned", () => {
    const pending = gateView(
      toJudgeInput([
        { type: "tool_call", id: "c1", name: "search", arguments: {} },
      ]),
    );
    expect(evaluateGate([{ event: "tool" }], pending)).toBe(false);
  });

  it("throws when only a truncated result could decide the gate", () => {
    const truncated = gateView(
      toJudgeInput([
        { type: "tool_call", id: "c1", name: "search", arguments: {} },
        { type: "tool_result", tool_call_id: "c1", content: "x".repeat(5000) },
      ]),
    );
    expect(() =>
      evaluateGate([{ event: "tool", match: { result: "needle" } }], truncated),
    ).toThrow(/truncated tool result/);
    expect(
      evaluateGate([{ event: "tool", match: { name: "search" } }], truncated),
    ).toBe(true);
  });
});

describe("judge evidence", () => {
  it("renders the normalized trajectory with sorted keys and labelled system instructions", () => {
    const transcript = renderTrajectoryInput(toJudgeInput(EXPORT, "Be brief."));
    expect(transcript.startsWith("TRAJECTORY\n[")).toBe(true);
    expect(transcript).toContain('"arguments": {\n      "message": "hello"');
    expect(transcript).toContain("\n\nSYSTEM INSTRUCTIONS\nBe brief.");
    expect(transcript).not.toContain("meta");
  });

  it("slims long tool output for a classifier and cuts the middle to fit a budget", () => {
    const input = toJudgeInput([
      { type: "tool_call", id: "c1", name: "read", arguments: {} },
      { type: "tool_result", tool_call_id: "c1", content: "x".repeat(9000) },
      { type: "tool_call", id: "c2", name: "read", arguments: {} },
      {
        type: "tool_result",
        tool_call_id: "c2",
        content: `${"y".repeat(9000)} permission denied`,
      },
    ]);
    const slim = renderTrajectoryInput(input, { slim: true });
    // Jev's slim: head and tail of a long result, an error kept whole.
    expect(slim).toContain(`${"x".repeat(150)} […] ${"x".repeat(150)}`);
    expect(slim).not.toContain("x".repeat(151));
    expect(slim).toContain(`${"y".repeat(9000)} permission denied`);
    const cut = renderTrajectoryInput(input, { maxUnits: 500 });
    expect(cut.length).toBeLessThanOrEqual(500);
    expect(cut).toContain("transcript middle redacted");
  });

  it("derives a stable judgement id and sample from the judge and the evidence", () => {
    const judge = "018f0000-0000-7000-8000-000000000001";
    const id = judgementId(judge, "hash", "evidence", "conversation");
    expect(id).toBe(judgementId(judge, "hash", "evidence", "conversation"));
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(id).not.toBe(
      judgementId(judge, "other", "evidence", "conversation"),
    );
    expect(samplesIn(judge, "c", 1)).toBe(true);
    expect(samplesIn(judge, "c", 0)).toBe(false);
    const sampled = Array.from({ length: 2000 }, (_, i) =>
      samplesIn(judge, `conversation-${i}`, 0.25),
    ).filter(Boolean).length;
    expect(sampled).toBeGreaterThan(400);
    expect(sampled).toBeLessThan(600);
  });
});

describe("judge verdicts", () => {
  it.each([
    ["a json fence", '```json\n{"reasoning":"ok","verdict":"PASS"}\n```'],
    [
      "an upper-case JSON fence",
      '  ```JSON\n{"reasoning":"ok","verdict":"pass"}\n```\n',
    ],
    ["a bare fence", '```\n{"reasoning":"ok","verdict":"pass"}\n```'],
    ["no fence", '\n{"reasoning":"ok","verdict":"pass"}\n'],
  ])("reads an LLM verdict in %s", (_, reply) => {
    expect(completeLlmVerdict("transcript", reply)).toEqual({
      verdict: "pass",
      reasoning: "ok",
    });
  });

  it("strips one surrounding fence and nothing else", () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFence('```{"a":1}```')).toBe('{"a":1}');
    expect(stripCodeFence('{"a":"```"}')).toBe('{"a":"```"}');
    expect(stripCodeFence('prose ```json\n{"a":1}\n```')).not.toBe('{"a":1}');
  });

  it("refuses a verdict outside the vocabulary and output that echoes the transcript", () => {
    expect(() =>
      completeLlmVerdict("t", '{"reasoning":"x","verdict":"maybe"}'),
    ).toThrow(/outside the canonical vocabulary/);
    const span =
      "the customer wrote a long and rather specific sentence about their account";
    expect(() =>
      completeLlmVerdict(
        `USER: ${span}`,
        JSON.stringify({ reasoning: span.toUpperCase(), verdict: "fail" }),
      ),
    ).toThrow(/echoed a transcript span/);
  });

  it("passes a classifier judge only when every question reaches its own threshold", () => {
    const judge = parseJudgeDefinition("judges/polite.yaml", CLASSIFIER_JUDGE);
    if (judge?.kind !== "classifier") throw new Error("expected a classifier");
    const answer = (greeted: number, apologised: number) => ({
      greeted: { type: "bool", probability: greeted },
      apologised: { type: "bool", probability: apologised },
    });
    expect(
      completeClassifierVerdict(judge.questions, answer(0.9, 0.5)),
    ).toEqual({
      verdict: "pass",
      reasoning: "apologised 0.50 >= 0.50; greeted 0.90 >= 0.80",
      scores: { greeted: 0.9, apologised: 0.5 },
    });
    expect(
      completeClassifierVerdict(judge.questions, answer(0.79, 0.9)).verdict,
    ).toBe("fail");
    expect(() =>
      completeClassifierVerdict(judge.questions, {
        greeted: { type: "bool", probability: 0.9 },
      }),
    ).toThrow(/no answer to "apologised"/);
  });
});

describe("runJudges", () => {
  const judges = [
    parseJudgeDefinition("judges/greeting.yaml", LLM_JUDGE)!,
    parseJudgeDefinition("judges/polite.yaml", CLASSIFIER_JUDGE)!,
  ];
  const reply = (name: string) =>
    name === "greeting"
      ? '{"reasoning":"echoed","verdict":"pass"}'
      : JSON.stringify({
          answers: {
            greeted: { type: "bool", probability: 0.95 },
            apologised: { type: "bool", probability: 0.1 },
          },
        });

  it("judges several input files as one batch, skips a gate miss, and resumes", async () => {
    const fixture = writeFixtureRecipe();
    cleanups.push(fixture.cleanup);
    const directory = fixture.workspaceDir;
    const a = join(directory, "a.jsonl");
    const b = join(directory, "b.jsonl");
    writeFileSync(a, `${JSON.stringify(line("echo-1", EXPORT))}\n`);
    writeFileSync(
      b,
      `${JSON.stringify(line("talk-1", SMALL_TALK))}\n${JSON.stringify(line("echo-2", EXPORT))}\n`,
    );
    const first = scripted(reply);
    const outcome = await runJudges({
      judges,
      input: [a, b],
      controller: first.controller,
      directory,
      operational: {
        greeting: { judge_id: "018f0000-0000-7000-8000-000000000001" },
      },
    });

    expect(outcome.skipped).toEqual([
      { custom_id: "talk-1", judge: "greeting", reason: "gate" },
    ]);
    expect(
      outcome.results.map((r) => [r.judge, r.custom_id, r.result]),
    ).toEqual([
      ["greeting", "echo-1", "pass"],
      ["greeting", "echo-2", "pass"],
      ["polite", "echo-1", "fail"],
      ["polite", "talk-1", "fail"],
      ["polite", "echo-2", "fail"],
    ]);
    expect(outcome.results[0]).toMatchObject({
      status: "ok",
      reasoning: "echoed",
      contract_version: "3",
      conversation_id: "echo-1",
    });
    expect(outcome.results[0]!.judgement_id).toBeDefined();
    // The same evidence in two conversations is two judgements.
    expect(outcome.results[0]!.judgement_id).not.toBe(
      outcome.results[1]!.judgement_id,
    );
    expect(outcome.results[2]).toMatchObject({
      scores: { greeted: 0.95, apologised: 0.1 },
      reasoning: "apologised 0.10 < 0.50; greeted 0.95 >= 0.80",
    });
    expect(outcome.results[2]!.judgement_id).toBeUndefined();
    const written = readFileSync(join(directory, "results.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((raw) => JSON.parse(raw));
    expect(written).toEqual(outcome.results);

    const second = scripted(reply);
    const again = await runJudges({
      judges,
      input: [a, b],
      controller: second.controller,
      directory,
    });
    expect(second.started).toEqual([]);
    expect(again.results.map((r) => r.result)).toEqual(
      outcome.results.map((r) => r.result),
    );
  });

  it("names a line without a custom_id by its conversation id", async () => {
    const { controller } = scripted(reply);
    const { results } = await runJudges({
      judges: [judges[0]!],
      input: [{ conversation_id: "conv-1", trajectory: EXPORT } as never],
      controller,
    });
    expect(results).toMatchObject([
      { custom_id: "conv-1", conversation_id: "conv-1", result: "pass" },
    ]);
    await expect(
      runJudges({
        judges: [judges[0]!],
        input: [{ trajectory: EXPORT } as never],
        controller,
      }),
    ).rejects.toThrow(/custom_id or a conversation_id/);
  });

  it.each([
    ["a json fence", '```json\n{"reasoning":"ok","verdict":"fail"}\n```'],
    ["a bare fence", '```\n{"reasoning":"ok","verdict":"fail"}\n```'],
    ["no fence", '{"reasoning":"ok","verdict":"fail"}'],
  ])("grades a reply in %s without asking for a repair", async (_, text) => {
    const { controller } = scripted(() => text);
    const repairs: string[] = [];
    const { results } = await runJudges({
      judges: [judges[0]!],
      input: [line("fence-1", EXPORT)],
      controller: {
        ...controller,
        message: async (id, prompt) => {
          repairs.push(prompt);
          return controller.message(id, prompt);
        },
      },
    });
    expect(repairs).toEqual([]);
    expect(results).toMatchObject([{ result: "fail", reasoning: "ok" }]);
  });

  it("records a reply outside the contract as an error, never a fail", async () => {
    const { controller } = scripted(
      () => '{"reasoning":"x","verdict":"unsure"}',
    );
    const { results } = await runJudges({
      judges: [judges[0]!],
      input: [line("echo-1", EXPORT)],
      controller,
    });
    expect(results).toMatchObject([
      { result: "error", status: "error", error: /canonical vocabulary/ },
    ]);
  });

  it("records evidence it cannot read as an error for that conversation only", async () => {
    const { controller } = scripted(reply);
    const { results } = await runJudges({
      judges: [judges[1]!],
      input: [
        line("bad", [{ type: "tool_result", tool_call_id: "missing" }]),
        line("talk-1", SMALL_TALK),
      ],
      controller,
    });
    expect(results.map((r) => [r.custom_id, r.result])).toEqual([
      ["bad", "error"],
      ["talk-1", "fail"],
    ]);
  });

  it("skips a disabled judge, and samples only production conversations", async () => {
    const { controller, started } = scripted(reply);
    const { skipped } = await runJudges({
      judges,
      input: [
        { ...line("prod", SMALL_TALK), environment: "production" },
        line("dev", SMALL_TALK),
      ],
      controller,
      operational: {
        greeting: { enabled: false },
        polite: { sample_rate: 0 },
      },
    });
    expect(skipped).toEqual([
      { custom_id: "prod", judge: "greeting", reason: "disabled" },
      { custom_id: "dev", judge: "greeting", reason: "disabled" },
      { custom_id: "prod", judge: "polite", reason: "sampled_out" },
    ]);
    expect(started).toEqual(["polite:dev"]);
  });
});

describe("one conversation under many judges", () => {
  it("runs its judges at once, as lines of one batch", async () => {
    const judges = ["a", "b", "c"].map((name) =>
      parseJudgeDefinition(
        `judges/${name}.yaml`,
        `name: ${name}\nai:\n  model: faux/faux-1\ninstructions: Grade it.\n`,
      )!,
    );
    let inFlight = 0;
    let peak = 0;
    const waits = new Map<string, Promise<AgentRunSummary>>();
    const controller: BatchRunController = {
      async start(input) {
        const id = `run-${input.name}`;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        waits.set(
          id,
          new Promise((resolve) =>
            setTimeout(() => {
              inFlight -= 1;
              resolve(
                summary({
                  agent_run_id: id,
                  status: "completed",
                  output: '{"reasoning":"ok","verdict":"pass"}',
                }),
              );
            }, 20),
          ),
        );
        return summary({ agent_run_id: id });
      },
      wait: (id) => waits.get(id)!,
      message: async (id) => summary({ agent_run_id: id }),
      close: async (id) => summary({ agent_run_id: id, status: "closed" }),
    };
    const seen: string[] = [];
    const { results } = await runJudges({
      judges,
      input: [line("talk-1", SMALL_TALK)],
      controller,
      onResult: (result) => void seen.push(result.judge),
    });
    expect(peak).toBe(3);
    expect(results.map((r) => [r.judge, r.result])).toEqual([
      ["a", "pass"],
      ["b", "pass"],
      ["c", "pass"],
    ]);
    expect(seen.sort()).toEqual(["a", "b", "c"]);
  });
});

describe("runJudges reports who answered", () => {
  it("names the model and its usage, and leaves out usage Pi counted as zero", async () => {
    const judge = parseJudgeDefinition("judges/greeting.yaml", LLM_JUDGE)!;
    const { controller } = scripted(
      () => '{"reasoning":"echoed","verdict":"pass"}',
    );
    const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    const { results } = await runJudges({
      judges: [judge],
      input: [line("echo-1", EXPORT), line("echo-2", EXPORT)],
      controller: {
        ...controller,
        runDetails: (id) =>
          id === "run-1"
            ? { model: "faux/faux-1", usage }
            : {
                model: "faux-b/faux-b-1",
                usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 },
              },
      },
    });
    expect(results[0]).toMatchObject({ model: "faux/faux-1" });
    expect(results[0]).not.toHaveProperty("usage");
    expect(results[1]).toMatchObject({
      model: "faux-b/faux-b-1",
      usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 },
    });
  });

  it("asks again on resume when a reply was outside the judge's contract", async () => {
    const fixture = writeFixtureRecipe();
    cleanups.push(fixture.cleanup);
    const directory = fixture.workspaceDir;
    const judge = parseJudgeDefinition("judges/greeting.yaml", LLM_JUDGE)!;
    for (const reply of ["{}", '{"verdict":"maybe"}']) {
      const refused = scripted(() => reply);
      const before = await runJudges({
        judges: [judge],
        input: [line("echo-1", EXPORT)],
        controller: refused.controller,
        directory,
      });
      expect(before.results[0]).toMatchObject({ status: "error" });
      const recorded = readFileSync(
        join(directory, "batch", "results.jsonl"),
        "utf8",
      );
      expect(recorded).not.toContain('"succeeded"');

      const retried = scripted(() => '{"reasoning":"echoed","verdict":"pass"}');
      const after = await runJudges({
        judges: [judge],
        input: [line("echo-1", EXPORT)],
        controller: retried.controller,
        directory,
      });
      expect(retried.started).toHaveLength(1);
      expect(after.results[0]).toMatchObject({ result: "pass", status: "ok" });
      rmSync(join(directory, "batch"), { recursive: true, force: true });
      rmSync(join(directory, "results.jsonl"), { force: true });
    }
  });

  it("keeps the model and usage of judgements a resumed run already had", async () => {
    const fixture = writeFixtureRecipe();
    cleanups.push(fixture.cleanup);
    const directory = fixture.workspaceDir;
    const judge = parseJudgeDefinition("judges/greeting.yaml", LLM_JUDGE)!;
    const answer = () => '{"reasoning":"echoed","verdict":"pass"}';
    const usage = { input_tokens: 9, output_tokens: 1, total_tokens: 10 };
    const first = scripted(answer);
    const before = await runJudges({
      judges: [judge],
      input: [line("echo-1", EXPORT)],
      controller: {
        ...first.controller,
        runDetails: () => ({ model: "faux/faux-1", usage }),
      },
      directory,
    });
    expect(before.results[0]).toMatchObject({ model: "faux/faux-1", usage });

    // A fresh controller, as a restarted process has, knows no earlier run.
    const second = scripted(answer);
    const after = await runJudges({
      judges: [judge],
      input: [line("echo-1", EXPORT)],
      controller: { ...second.controller, runDetails: () => ({}) },
      directory,
    });
    expect(second.started).toEqual([]);
    expect(after.results[0]).toMatchObject({ model: "faux/faux-1", usage });
    const written = readFileSync(join(directory, "results.jsonl"), "utf8");
    expect(JSON.parse(written.trim())).toMatchObject({
      model: "faux/faux-1",
      usage,
    });

    // A crash mid-append leaves a torn last line; the next run trims it, so
    // the details appended after it still read back.
    const details = join(directory, "run-details.jsonl");
    writeFileSync(details, `${readFileSync(details, "utf8")}{"run_id":"run-`);
    const third = scripted(answer);
    await runJudges({
      judges: [judge],
      input: [line("echo-2", EXPORT)],
      controller: {
        ...third.controller,
        runDetails: () => ({ model: "faux/faux-2", usage }),
      },
      directory,
    });
    const resumed = await runJudges({
      judges: [judge],
      input: [line("echo-2", EXPORT)],
      controller: { ...scripted(answer).controller, runDetails: () => ({}) },
      directory,
    });
    expect(resumed.results[0]).toMatchObject({ model: "faux/faux-2", usage });
    expect(
      readFileSync(details, "utf8")
        .trim()
        .split("\n")
        .map((raw) => JSON.parse(raw).model),
    ).toEqual(["faux/faux-1", "faux/faux-2"]);
  });
});

describe("createJudgeRunController", () => {
  it("runs an LLM judge as a tool-less session that falls back once its model has been retried twice", async () => {
    const fixture = writeFixtureRecipe();
    cleanups.push(fixture.cleanup);
    const judges = [parseJudgeDefinition("judges/greeting.yaml", LLM_JUDGE)!];
    const primary = fauxProvider();
    const fallback = fauxProvider({
      provider: "faux-b",
      models: [{ id: "faux-b-1" }],
    });
    const seen: { system: string; tools: number; prompt: string }[] = [];
    const rateLimited = () =>
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "429 Too Many Requests",
      });
    // The first request and the two retries the judge's model is allowed.
    primary.setResponses([rateLimited, rateLimited, rateLimited]);
    fallback.setResponses([
      (context) => {
        const user = context.messages.find((m) => m.role === "user");
        seen.push({
          system: JSON.stringify(
            context.messages.filter((m) => (m.role as string) === "system"),
          ),
          tools: (context as { tools?: unknown[] }).tools?.length ?? 0,
          prompt: JSON.stringify(user?.content),
        });
        return fauxAssistantMessage('{"reasoning":"echoed","verdict":"pass"}');
      },
    ]);
    const models: Record<string, unknown> = {
      "faux/faux-1": primary.getModel(),
      "faux-b/faux-b-1": fallback.getModel(),
    };
    const controller = createJudgeRunController({
      recipe: resolveRecipe({ recipeDir: fixture.recipeDir }),
      judges,
      cwd: fixture.workspaceDir,
      env: cleanEnv(),
      settingsManager: SettingsManager.inMemory({
        retry: { enabled: true, maxRetries: 4, baseDelayMs: 1 },
      }),
      modelRegistry: {
        find: (provider: string, id: string) => models[`${provider}/${id}`],
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
      } as never,
      sessionFactory: (options) =>
        createAgentSessionInternal({
          ...options,
          extensionFactories: [
            (pi) => pi.registerProvider(primary.provider),
            (pi) => pi.registerProvider(fallback.provider),
          ],
          mcpBindings: { servers: [] },
        }),
    });
    cleanups.push(() => controller.shutdown());

    const { results } = await runJudges({
      judges,
      input: [line("echo-1", EXPORT)],
      controller,
    });

    expect(results).toMatchObject([
      {
        judge: "greeting",
        result: "pass",
        reasoning: "echoed",
        // The fallback answered, and the hash is of the evidence it read.
        model: "faux-b/faux-b-1",
        sequence_hash: evidenceHash(toJudgeInput(EXPORT)),
      },
    ]);
    // Usage is reported only when Pi counted tokens, and never as zero.
    const usage = results[0]!.usage;
    if (usage) expect(usage.total_tokens).toBeGreaterThan(0);
    expect(primary.state.callCount).toBe(3);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.system).toContain("Did the assistant echo the message?");
    expect(seen[0]!.system).toContain("Reply with only a JSON object");
    expect(seen[0]!.system).not.toContain("conformance fixture");
    expect(seen[0]!.tools).toBe(0);
    expect(seen[0]!.prompt).toContain("TRAJECTORY");
  });

  it("asks the classifier a judge's questions, and its fallback when the first model fails", async () => {
    const fixture = writeFixtureRecipe();
    cleanups.push(fixture.cleanup);
    const judges = [
      parseJudgeDefinition("judges/polite.yaml", CLASSIFIER_JUDGE)!,
    ];
    const asked: Parameters<JudgeClassifier>[0][] = [];
    const controller = createJudgeRunController({
      recipe: resolveRecipe({ recipeDir: fixture.recipeDir }),
      judges,
      cwd: fixture.workspaceDir,
      classify: async (request): ReturnType<JudgeClassifier> => {
        asked.push(request);
        return request.model === "typesafe/jev-latest"
          ? {
              answers: {},
              stopReason: "error",
              errorMessage: "503 unavailable",
            }
          : {
              answers: {
                greeted: { type: "bool", probability: 0.99 },
                apologised: { type: "bool", probability: 0.7 },
              },
              stopReason: "stop" as const,
              usage: {
                input: 120,
                output: 4,
                cacheRead: 30,
                cacheWrite: 0,
                totalTokens: 154,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
            };
      },
    });
    cleanups.push(() => controller.shutdown());

    const { results } = await runJudges({
      judges,
      input: [line("talk-1", SMALL_TALK)],
      controller,
    });

    expect(results).toMatchObject([
      {
        judge: "polite",
        result: "pass",
        model: "openai/gpt-6-luna",
        usage: { input_tokens: 150, output_tokens: 4, total_tokens: 154 },
        sequence_hash: evidenceHash(toJudgeInput(SMALL_TALK)),
      },
    ]);
    expect(asked.map((request) => request.model)).toEqual([
      "typesafe/jev-latest",
      "openai/gpt-6-luna",
    ]);
    expect(asked[0]!.questions).toEqual({
      greeted: {
        type: "bool",
        instructions: "Did the assistant greet the user?",
        criteria: {
          true: "The first reply opens with a greeting.",
          false: "It does not.",
        },
      },
      apologised: {
        type: "bool",
        instructions: "Did the assistant apologise?",
        criteria: { true: "It says sorry.", false: "It does not." },
      },
    });
    expect(String(asked[0]!.state.conversation)).toContain("hi there");
  });

  it("adds up a classifier judge's usage across its fallbacks, and leaves it out when none was reported", async () => {
    const tokens = (input: number, output: number) => ({
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    const judge = async (
      failed: Awaited<ReturnType<JudgeClassifier>>["usage"],
      answered: Awaited<ReturnType<JudgeClassifier>>["usage"],
    ) => {
      const fixture = writeFixtureRecipe();
      cleanups.push(fixture.cleanup);
      const judges = [
        parseJudgeDefinition("judges/polite.yaml", CLASSIFIER_JUDGE)!,
      ];
      const controller = createJudgeRunController({
        recipe: resolveRecipe({ recipeDir: fixture.recipeDir }),
        judges,
        cwd: fixture.workspaceDir,
        classify: async (request): ReturnType<JudgeClassifier> =>
          request.model === "typesafe/jev-latest"
            ? {
                answers: {},
                stopReason: "error",
                errorMessage: "503 unavailable",
                ...(failed ? { usage: failed } : {}),
              }
            : {
                answers: {
                  greeted: { type: "bool", probability: 0.99 },
                  apologised: { type: "bool", probability: 0.7 },
                },
                stopReason: "stop" as const,
                ...(answered ? { usage: answered } : {}),
              },
      });
      cleanups.push(() => controller.shutdown());
      const { results } = await runJudges({
        judges,
        input: [line("talk-1", SMALL_TALK)],
        controller,
      });
      return results[0]!;
    };

    expect((await judge(tokens(100, 1), tokens(50, 2))).usage).toEqual({
      input_tokens: 150,
      output_tokens: 3,
      total_tokens: 153,
    });
    // A last reply without usage keeps what the failed call reported.
    expect((await judge(tokens(100, 1), undefined)).usage).toEqual({
      input_tokens: 100,
      output_tokens: 1,
      total_tokens: 101,
    });
    const unreported = await judge(undefined, undefined);
    expect(unreported).toMatchObject({ model: "openai/gpt-6-luna" });
    expect(unreported).not.toHaveProperty("usage");
  });

  it("fails a classifier judge's line when the run was given no classifier", async () => {
    const fixture = writeFixtureRecipe();
    cleanups.push(fixture.cleanup);
    const judges = [
      parseJudgeDefinition("judges/polite.yaml", CLASSIFIER_JUDGE)!,
    ];
    const controller = createJudgeRunController({
      recipe: resolveRecipe({ recipeDir: fixture.recipeDir }),
      judges,
      cwd: fixture.workspaceDir,
    });
    cleanups.push(() => controller.shutdown());
    const { results } = await runJudges({
      judges,
      input: [line("talk-1", SMALL_TALK)],
      controller,
    });
    expect(results).toMatchObject([
      { result: "error", error: /asks a classifier/ },
    ]);
  });
});

describe("the judges command-line entry", () => {
  it("parses repeated inputs and judges, and refuses a run with no input", () => {
    expect(
      parseJudgeCliArgs([
        "--recipe",
        "r",
        "--input",
        "a.jsonl",
        "--input",
        "-",
        "--judge",
        "greeting",
        "--concurrency",
        "4",
        "--fallback-after-retries",
        "0",
      ]),
    ).toEqual({
      recipe: "r",
      input: ["a.jsonl", "-"],
      judge: ["greeting"],
      concurrency: 4,
      fallbackAfterRetries: 0,
    });
    expect(() => parseJudgeCliArgs(["--recipe", "r"])).toThrow(/--input/);
    expect(() =>
      parseJudgeCliArgs([
        "--recipe",
        "r",
        "--input",
        "a",
        "--concurrency",
        "x",
      ]),
    ).toThrow(/whole number/);
  });

  it("judges files and stdin together with the named judges, and reports counts", async () => {
    const fixture = writeFixtureRecipe();
    cleanups.push(fixture.cleanup);
    const directory = join(fixture.recipeDir, "judges");
    mkdirSync(directory);
    writeFileSync(join(directory, "greeting.yaml"), LLM_JUDGE);
    writeFileSync(join(directory, "polite.yaml"), CLASSIFIER_JUDGE);
    const file = join(fixture.workspaceDir, "a.jsonl");
    writeFileSync(file, `${JSON.stringify(line("echo-1", EXPORT))}\n`);
    const operational = join(fixture.workspaceDir, "operational.json");
    writeFileSync(
      operational,
      JSON.stringify({
        greeting: { judge_id: "018f0000-0000-7000-8000-000000000001" },
      }),
    );
    const seen: string[][] = [];
    const report = await judgeCli(
      {
        recipe: fixture.recipeDir,
        input: [file, "-"],
        judge: ["greeting"],
        out: join(fixture.workspaceDir, "out"),
        operational,
      },
      {
        readStdin: async () => `${JSON.stringify(line("echo-2", EXPORT))}\n`,
        controller: async (judges) => {
          seen.push(judges.map((judge) => judge.name));
          return scripted(() => '{"reasoning":"echoed","verdict":"pass"}')
            .controller;
        },
      },
    );
    expect(seen).toEqual([["greeting"]]);
    expect(report.schema_version).toBe(2);
    expect(report.counts).toEqual({
      pass: 2,
      fail: 0,
      not_applicable: 0,
      error: 0,
    });
    expect(report.results.map((r) => r.custom_id)).toEqual([
      "echo-1",
      "echo-2",
    ]);
    expect(report.results[0]!.judgement_id).toBeDefined();
    expect(
      readFileSync(join(fixture.workspaceDir, "out", "results.jsonl"), "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(2);
  });

  it("reads --definitions in place of recipe-check, spawning nothing", async () => {
    const fixture = writeFixtureRecipe();
    cleanups.push(fixture.cleanup);
    mkdirSync(join(fixture.recipeDir, "judges"));
    writeFileSync(
      join(fixture.recipeDir, "judges", "greeting.yaml"),
      LLM_JUDGE,
    );
    // What a host that links recipe-check passes: the binary's own output.
    const printed = spawnSync(
      process.env.INTROSPECTION_RECIPE_CHECK!,
      ["judges"],
      {
        input: JSON.stringify([
          { path: "judges/greeting.yaml", content: LLM_JUDGE },
        ]),
        encoding: "utf8",
      },
    );
    expect(printed.status).toBe(0);
    const definitions = join(fixture.workspaceDir, "definitions.json");
    writeFileSync(definitions, printed.stdout);
    // A recipe-check that cannot run: reaching for it would fail the run.
    vi.stubEnv("INTROSPECTION_RECIPE_CHECK", "/nonexistent/recipe-check");
    cleanups.push(() => {
      vi.unstubAllEnvs();
    });
    expect(() => loadJudges(fixture.recipeDir)).toThrow(
      /INTROSPECTION_RECIPE_CHECK/,
    );

    const args = parseJudgeCliArgs([
      "--recipe",
      fixture.recipeDir,
      "--input",
      "-",
      "--definitions",
      definitions,
    ]);
    expect(args.definitions).toBe(definitions);
    const report = await judgeCli(args, {
      readStdin: async () => `${JSON.stringify(line("echo-1", EXPORT))}\n`,
      controller: async () =>
        scripted(() => '{"reasoning":"echoed","verdict":"pass"}').controller,
    });
    expect(report.results).toMatchObject([
      { judge: "greeting", result: "pass" },
    ]);
  });

  it("prints its protocol for --schema, and runs on PI_PACKAGE_DIR with no pi binary", () => {
    const cli = fileURLToPath(
      new URL("../dist/judges/cli.js", import.meta.url),
    );
    const bare = { PATH: "", HOME: process.env.HOME ?? "" };
    const schema = spawnSync(process.execPath, [cli, "--schema"], {
      env: bare,
      encoding: "utf8",
    });
    expect(schema.status).toBe(0);
    expect(schema.stdout).toBe('{"schema_version":2}\n');

    // The runtime image: Pi's packages under PI_PACKAGE_DIR, no `pi` on PATH.
    const fixture = writeFixtureRecipe();
    cleanups.push(fixture.cleanup);
    const input = join(fixture.workspaceDir, "in.jsonl");
    writeFileSync(input, "");
    const definitions = join(fixture.workspaceDir, "definitions.json");
    writeFileSync(definitions, "[]");
    const run = spawnSync(
      process.execPath,
      [
        cli,
        "--recipe",
        fixture.recipeDir,
        "--input",
        input,
        "--definitions",
        definitions,
      ],
      {
        cwd: fixture.workspaceDir,
        env: {
          ...bare,
          HOME: fixture.workspaceDir,
          PI_PACKAGE_DIR: realpathSync(
            fileURLToPath(
              new URL(
                "../node_modules/@earendil-works/pi-coding-agent",
                import.meta.url,
              ),
            ),
          ),
        },
        encoding: "utf8",
      },
    );
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      schema_version: 2,
      results: [],
    });
  }, 60_000);

  it("names the Recipe's judges when asked for one it does not have", async () => {
    const fixture = writeFixtureRecipe();
    cleanups.push(fixture.cleanup);
    mkdirSync(join(fixture.recipeDir, "judges"));
    writeFileSync(
      join(fixture.recipeDir, "judges", "greeting.yaml"),
      LLM_JUDGE,
    );
    await expect(
      judgeCli({ recipe: fixture.recipeDir, input: ["x"], judge: ["nope"] }),
    ).rejects.toThrow(/no judge named nope; its judges are greeting/);
  });
});

describe("a Pi session as evidence", () => {
  const SESSION = [
    { type: "session", version: 3, id: "C1" },
    { type: "model_change", id: "m", parentId: null },
    {
      type: "message",
      id: "s",
      parentId: "m",
      message: { role: "system", content: "", sections: { preamble: "x" } },
    },
    {
      type: "message",
      id: "u",
      parentId: "s",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "say hello" }] },
    },
    // An abandoned branch: a reply the user rewound past.
    {
      type: "message",
      id: "dead",
      parentId: "u",
      message: { role: "assistant", content: [{ type: "text", text: "nope" }] },
    },
    {
      type: "message",
      id: "a",
      parentId: "u",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private" },
          {
            type: "toolCall",
            id: "c1",
            name: "mcp_hello_echo",
            arguments: { message: "hello" },
          },
        ],
      },
    },
    {
      type: "message",
      id: "t",
      parentId: "a",
      message: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "mcp_hello_echo",
        isError: false,
        content: [{ type: "text", text: "Echo: hello" }],
      },
    },
    {
      type: "message",
      id: "f",
      parentId: "t",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
      },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");

  it("reads the active branch's messages and tool calls, without the system prompt or reasoning", () => {
    expect(trajectoryFromPiSession(SESSION)).toEqual([
      {
        type: "message",
        role: "user",
        content: "say hello",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        type: "tool_call",
        id: "c1",
        name: "mcp_hello_echo",
        arguments: { message: "hello" },
      },
      {
        type: "tool_result",
        tool_call_id: "c1",
        name: "mcp_hello_echo",
        content: "Echo: hello",
      },
      { type: "message", role: "assistant", content: "Done." },
    ]);
    expect(() => trajectoryFromPiSession("{}")).toThrow(/not a Pi session/);
  });

  it("reads a JSON tool result as the export does, so a gate on its fields matches either", () => {
    const shipped = SESSION.replace(
      '"text":"Echo: hello"',
      '"text":"{\\"status\\":\\"shipped\\"}"',
    );
    const result = trajectoryFromPiSession(shipped).find(
      (event) => event.type === "tool_result",
    );
    const exported = normalizeReplayTrajectory([
      {
        role: "assistant",
        timestamp: "t",
        tool_calls: [{ id: "c1", name: "mcp_hello_echo", args: "{}" }],
      },
      {
        role: "tool",
        tool_call_id: "c1",
        content: '{"status":"shipped"}',
        timestamp: "t",
      },
    ]).find((event) => event.type === "tool_result");
    expect(result).toMatchObject({ content: { status: "shipped" } });
    expect(exported).toMatchObject({
      content: (result as { content: unknown }).content,
    });
  });

  it("judges a line that names a session file", async () => {
    const fixture = writeFixtureRecipe();
    cleanups.push(fixture.cleanup);
    const session = join(fixture.workspaceDir, "session.jsonl");
    writeFileSync(session, SESSION);
    const input = join(fixture.workspaceDir, "in.jsonl");
    writeFileSync(
      input,
      `${JSON.stringify({ custom_id: "C1", session_file: session })}\n`,
    );
    const prompts: string[] = [];
    const { controller } = scripted((_name, prompt) => {
      prompts.push(prompt);
      return '{"reasoning":"echoed","verdict":"pass"}';
    });
    const { results } = await runJudges({
      judges: [parseJudgeDefinition("judges/greeting.yaml", LLM_JUDGE)!],
      input: [input],
      controller,
    });
    expect(results).toMatchObject([{ custom_id: "C1", result: "pass" }]);
    expect(prompts[0]).toContain("Echo: hello");
    expect(prompts[0]).not.toContain("private");
  });
});

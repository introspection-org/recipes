import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type {
  AgentRunController,
  AgentRunStatus,
  AgentRunSummary,
} from "../src/agents.js";
import {
  AdaptiveLimiter,
  completedIds,
  inputFingerprint,
  jsonlResults,
  nodeBatchFiles,
  parseBatchParams,
  parseInputLines,
  ResultShards,
  runBatch,
  runBatchWith,
  type BatchFiles,
  type BatchProgress,
  type BatchRunController,
} from "../src/batch/index.js";
import { activeBaggage, useAsyncContext } from "./helpers/otel-context.js";

/** What resume compares: the line's fingerprint under the "summarize" agent these tests run. */
const sha = (prompt: string) =>
  inputFingerprint("summarize", { custom_id: "", prompt });

const INPUT = "/files/prompts.jsonl";
const OUTPUT = "/outputs/results.jsonl";

/** A whole `AgentRunSummary` from the few fields a fake decides. */
function summary(run: {
  agent_run_id: string;
  status?: string;
  output?: string;
  error?: string;
}): AgentRunSummary {
  return {
    agent_run_id: run.agent_run_id,
    invocation_name: "summarize:1",
    agent_name: "summarize",
    label: run.agent_run_id,
    prompt: "",
    status: (run.status ?? "running") as AgentRunStatus,
    started_at: 0,
    last_activity_at: 0,
    ...(run.output !== undefined ? { output: run.output } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
  };
}

interface LooseRun {
  agent_run_id: string;
  status?: string;
  output?: string;
  error?: string;
}

/** A test's loose fake, as the controller a batch drives; the fake keeps its own state. */
function controllerOf(fake: {
  start(input: {
    name: string;
    prompt: string;
    label?: string;
  }): Promise<LooseRun>;
  wait(id: string, signal?: AbortSignal): Promise<LooseRun>;
  message(id: string, text: string): Promise<unknown>;
  close(id: string): Promise<unknown>;
}): BatchRunController {
  return {
    start: async (input) => summary(await fake.start(input)),
    wait: async (id, signal) => summary(await fake.wait(id, signal)),
    message: async (id, text) => {
      await fake.message(id, text);
      return summary({ agent_run_id: id });
    },
    close: async (id) => {
      await fake.close(id);
      return summary({ agent_run_id: id, status: "closed" });
    },
  };
}

function memoryFiles(initial: Record<string, string>): BatchFiles & {
  text: (path: string) => string;
} {
  const store = new Map(Object.entries(initial));
  return {
    async read(path) {
      return store.get(path) ?? null;
    },
    async appendLine(path, line) {
      store.set(path, `${store.get(path) ?? ""}${line}\n`);
    },
    async write(path, text) {
      store.set(path, text);
    },
    async list(dir) {
      const prefix = `${dir}/`;
      return [...store.keys()]
        .filter(
          (path) =>
            path.startsWith(prefix) && !path.slice(prefix.length).includes("/"),
        )
        .map((path) => path.slice(prefix.length));
    },
    async remove(path) {
      store.delete(path);
    },
    text: (path) => store.get(path) ?? "",
  };
}

function jsonl(...lines: object[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

type Outcome = { status: string; output?: string; error?: string };

/** Answers each prompt from a script; tracks concurrency and that every run is closed. */
class FakeController {
  active = 0;
  peak = 0;
  started: string[] = [];
  closed = new Set<string>();
  private readonly runs = new Map<string, string>();
  private counter = 0;

  constructor(
    private readonly answer: (prompt: string, attempt: number) => Outcome,
  ) {}

  async start(input: { name: string; prompt: string }) {
    const id = `run-${++this.counter}`;
    this.runs.set(id, input.prompt);
    this.started.push(input.prompt);
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    return { agent_run_id: id };
  }

  async wait(id: string) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    const prompt = this.runs.get(id) ?? "";
    const attempt = this.started.filter((p) => p === prompt).length;
    this.active -= 1;
    return { agent_run_id: id, ...this.answer(prompt, attempt) };
  }

  async close(id: string) {
    this.closed.add(id);
  }

  async message() {
    throw new Error("FakeController takes no follow-ups");
  }
}

const noSleep = async () => {};

describe("batch lines", () => {
  it("refuses a repeated custom_id by line number", () => {
    expect(() =>
      parseInputLines(
        jsonl({ custom_id: "a", prompt: "x" }, { custom_id: "a", prompt: "y" }),
      ),
    ).toThrow(/line 2 repeats custom_id a/);
  });

  it("treats the last result line per custom_id as current", () => {
    const results = jsonl(
      {
        custom_id: "a",
        result: { type: "errored" },
        batch: { input_sha256: "x" },
      },
      {
        custom_id: "a",
        result: { type: "succeeded" },
        batch: { input_sha256: "x" },
      },
      {
        custom_id: "b",
        result: { type: "succeeded" },
        batch: { input_sha256: "x" },
      },
      {
        custom_id: "b",
        result: { type: "canceled" },
        batch: { input_sha256: "x" },
      },
    );
    expect([...completedIds(results).keys()]).toEqual(["a"]);
  });
});

describe("runBatch", () => {
  it("runs every line in a fresh, closed session, never above the concurrency", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({
      custom_id: `c${i}`,
      prompt: `p${i}`,
    }));
    const files = memoryFiles({ [INPUT]: jsonl(...lines) });
    const controller = new FakeController((prompt) => ({
      status: "completed",
      output: `answer to ${prompt}`,
    }));

    const summary = await runBatchWith(
      {
        agent: "summarize",
        output_name: "results.jsonl",
        concurrency: 4,
        max_attempts: 3,
      },
      {
        controller: controllerOf(controller),
        files,
        input: INPUT,
        results: jsonlResults(files, OUTPUT),
        sleep: noSleep,
      },
    );

    expect(summary).toEqual({
      total: 20,
      already_completed: 0,
      completed: 20,
      failed: 0,
      not_started: 0,
      stopped: false,
    });
    expect(controller.peak).toBeLessThanOrEqual(4);
    expect(controller.closed.size).toBe(20);
    const results = files
      .text(OUTPUT)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(results.find((r) => r.custom_id === "c3")).toEqual({
      custom_id: "c3",
      result: {
        type: "succeeded",
        output: "answer to p3",
        run_id: expect.stringMatching(/^run-/),
      },
      batch: { record_index: 3, input_sha256: sha("p3"), attempts: 1 },
    });
  });

  it("copies each line's metadata onto its result, so the results file stands alone", async () => {
    const files = memoryFiles({
      [INPUT]: jsonl(
        {
          custom_id: "a",
          prompt: "pa",
          metadata: { segment: 3, watermark: "2026-11-13T00:00:00Z" },
        },
        { custom_id: "b", prompt: "pb" },
      ),
    });
    const controller = new FakeController(() => ({
      status: "completed",
      output: "ok",
    }));

    await runBatchWith(
      {
        agent: "summarize",
        output_name: "results.jsonl",
        concurrency: 2,
        max_attempts: 1,
      },
      {
        controller: controllerOf(controller),
        files,
        input: INPUT,
        results: jsonlResults(files, OUTPUT),
        sleep: noSleep,
      },
    );

    const results = Object.fromEntries(
      files
        .text(OUTPUT)
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
        .map((r) => [r.custom_id, r]),
    );
    expect(results.a.metadata).toEqual({
      segment: 3,
      watermark: "2026-11-13T00:00:00Z",
    });
    expect(results.b).not.toHaveProperty("metadata");
  });

  it("skips lines a previous run completed and retries ones it failed", async () => {
    const files = memoryFiles({
      [INPUT]: jsonl(
        { custom_id: "a", prompt: "pa" },
        { custom_id: "b", prompt: "pb" },
      ),
      [OUTPUT]: jsonl(
        {
          custom_id: "a",
          result: { type: "succeeded", output: "done" },
          batch: { record_index: 0, input_sha256: sha("pa"), attempts: 1 },
        },
        {
          custom_id: "b",
          result: { type: "errored", error: { message: "boom" } },
          batch: { record_index: 1, input_sha256: sha("pb"), attempts: 1 },
        },
      ),
    });
    const controller = new FakeController(() => ({
      status: "completed",
      output: "ok",
    }));

    const summary = await runBatchWith(
      {
        agent: "summarize",
        output_name: "results.jsonl",
        concurrency: 8,
        max_attempts: 3,
      },
      {
        controller: controllerOf(controller),
        files,
        input: INPUT,
        results: jsonlResults(files, OUTPUT),
        sleep: noSleep,
      },
    );

    expect(controller.started).toEqual(["pb"]);
    expect(summary).toMatchObject({
      total: 2,
      already_completed: 1,
      completed: 1,
    });
  });

  it("retries a rate-limited line and records any other failure once", async () => {
    const files = memoryFiles({
      [INPUT]: jsonl(
        { custom_id: "limited", prompt: "pl" },
        { custom_id: "broken", prompt: "pb" },
      ),
    });
    const controller = new FakeController((prompt, attempt) => {
      if (prompt === "pl") {
        return attempt < 3
          ? {
              status: "failed",
              error: "provider returned 429 Too Many Requests",
            }
          : { status: "completed", output: "late" };
      }
      return { status: "failed", error: "schema validation failed" };
    });

    const summary = await runBatchWith(
      {
        agent: "summarize",
        output_name: "results.jsonl",
        concurrency: 2,
        max_attempts: 3,
      },
      {
        controller: controllerOf(controller),
        files,
        input: INPUT,
        results: jsonlResults(files, OUTPUT),
        sleep: noSleep,
      },
    );

    expect(summary).toMatchObject({ completed: 1, failed: 1 });
    const results = files
      .text(OUTPUT)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(results.find((r) => r.custom_id === "limited")).toMatchObject({
      result: { type: "succeeded" },
      batch: { attempts: 3 },
    });
    expect(results.find((r) => r.custom_id === "broken")).toMatchObject({
      result: {
        type: "errored",
        error: { message: "schema validation failed" },
      },
      batch: { attempts: 1 },
    });
  });

  it("fails only the line whose session cannot start", async () => {
    const files = memoryFiles({
      [INPUT]: jsonl(
        { custom_id: "ok-1", prompt: "p1" },
        { custom_id: "broken", prompt: "no-credential" },
        { custom_id: "ok-2", prompt: "p2" },
      ),
    });
    const controller = new FakeController(() => ({
      status: "completed",
      output: "ok",
    }));
    const start = controller.start.bind(controller);
    controller.start = async (input) => {
      if (input.prompt === "no-credential") {
        throw new Error('No credential for model provider "openai-codex"');
      }
      return start(input);
    };

    const summary = await runBatchWith(
      {
        agent: "summarize",
        output_name: "results.jsonl",
        concurrency: 2,
        max_attempts: 3,
      },
      {
        controller: controllerOf(controller),
        files,
        input: INPUT,
        results: jsonlResults(files, OUTPUT),
        sleep: noSleep,
      },
    );

    expect(summary).toMatchObject({ completed: 2, failed: 1 });
    const broken = files
      .text(OUTPUT)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((r) => r.custom_id === "broken");
    expect(broken).toMatchObject({
      result: { type: "errored" },
      batch: { attempts: 1 },
    });
    expect(broken.result).not.toHaveProperty("run_id");
    expect(broken.result.error.message).toMatch(
      /session did not start: No credential/,
    );
  });

  it("stops starting lines at the deadline and leaves them for the next run", async () => {
    let clock = 0;
    const files = memoryFiles({
      [INPUT]: jsonl(
        ...Array.from({ length: 5 }, (_, i) => ({
          custom_id: `c${i}`,
          prompt: `p${i}`,
        })),
      ),
    });
    const controller = new FakeController(() => {
      clock += 100;
      return { status: "completed", output: "ok" };
    });

    const summary = await runBatchWith(
      {
        agent: "summarize",
        output_name: "results.jsonl",
        concurrency: 1,
        max_attempts: 1,
        deadline_ms: 250,
      },
      {
        controller: controllerOf(controller),
        files,
        input: INPUT,
        results: jsonlResults(files, OUTPUT),
        now: () => clock,
        sleep: noSleep,
      },
    );

    expect(summary).toMatchObject({ total: 5, completed: 3, not_started: 2 });
  });
});

describe("runBatch json repair", () => {
  /** Each run answers from a script of replies, one per turn. */
  function scripted(replies: Record<string, string[]>) {
    const turns = new Map<string, number>();
    const followUps: string[] = [];
    return {
      followUps,
      async start(input: { prompt: string }) {
        turns.set(input.prompt, 0);
        return { agent_run_id: input.prompt };
      },
      async wait(id: string) {
        const turn = turns.get(id) ?? 0;
        return {
          agent_run_id: id,
          status: "completed",
          output: replies[id][turn],
        };
      },
      async message(id: string, text: string) {
        followUps.push(text);
        turns.set(id, (turns.get(id) ?? 0) + 1);
      },
      async close() {},
    };
  }
  const params = {
    agent: "summarize",
    output_name: "results.jsonl",
    concurrency: 2,
    max_attempts: 1,
    output_format: "json" as const,
  };

  it("sends a malformed answer back to its session and keeps the corrected one", async () => {
    const files = memoryFiles({
      [INPUT]: jsonl({ custom_id: "a", prompt: "pa" }),
    });
    const controller = scripted({
      pa: ['{"answer":{"summary":"x"}]}', '{"answer":{"summary":"x"}}'],
    });

    const summary = await runBatchWith(params, {
      controller: controllerOf(controller),
      files,
      input: INPUT,
      results: jsonlResults(files, OUTPUT),
      sleep: noSleep,
    });

    expect(summary).toMatchObject({ completed: 1, failed: 0 });
    expect(controller.followUps).toHaveLength(1);
    expect(controller.followUps[0]).toMatch(/not valid JSON/);
    expect(JSON.parse(files.text(OUTPUT))).toMatchObject({
      result: {
        type: "succeeded",
        output: '{"answer":{"summary":"x"}}',
      },
    });
  });

  it("fails the line when the answer is still not JSON after the repairs", async () => {
    const files = memoryFiles({
      [INPUT]: jsonl({ custom_id: "a", prompt: "pa" }),
    });
    const controller = scripted({ pa: ["Sure! {", "still {", "nope {"] });

    const summary = await runBatchWith(params, {
      controller: controllerOf(controller),
      files,
      input: INPUT,
      results: jsonlResults(files, OUTPUT),
      sleep: noSleep,
    });

    expect(summary).toMatchObject({ completed: 0, failed: 1 });
    expect(controller.followUps).toHaveLength(2);
    expect(JSON.parse(files.text(OUTPUT)).result).toMatchObject({
      type: "errored",
      error: { message: expect.stringMatching(/not JSON after 2 repairs/) },
    });
  });

  it("leaves text answers alone", async () => {
    const files = memoryFiles({
      [INPUT]: jsonl({ custom_id: "a", prompt: "pa" }),
    });
    const controller = scripted({ pa: ["plain prose"] });

    await runBatchWith(
      { ...params, output_format: undefined },
      {
        controller: controllerOf(controller),
        files,
        input: INPUT,
        results: jsonlResults(files, OUTPUT),
        sleep: noSleep,
      },
    );

    expect(controller.followUps).toHaveLength(0);
  });
});

describe("runBatch restart and shutdown", () => {
  it("seals the open shard a dead run left, drops its torn last line, and runs that line again", async () => {
    const files = memoryFiles({
      [INPUT]: jsonl(
        { custom_id: "a", prompt: "pa" },
        { custom_id: "b", prompt: "pb" },
      ),
      // The process died while appending b's result to the open shard.
      "/work/results.open.jsonl":
        JSON.stringify({
          custom_id: "a",
          result: { type: "succeeded", output: "x" },
          batch: { record_index: 0, input_sha256: sha("pa"), attempts: 1 },
        }) + '\n{"custom_id": "b", "result": {"type": "succ',
    });
    const results = new ResultShards(files, "/outputs", "/work", "results");
    const controller = new FakeController(() => ({
      status: "completed",
      output: "ok",
    }));

    const summary = await runBatchWith(
      {
        agent: "summarize",
        output_name: "results.jsonl",
        concurrency: 2,
        max_attempts: 1,
      },
      {
        controller: controllerOf(controller),
        files,
        input: INPUT,
        results,
        sleep: noSleep,
      },
    );
    await results.seal();

    expect(controller.started).toEqual(["pb"]);
    expect(summary).toMatchObject({ already_completed: 1, completed: 1 });
    expect(await results.sealed()).toEqual([
      "results-0001.jsonl",
      "results-0002.jsonl",
    ]);
    expect(files.text("/outputs/results-0001.jsonl")).not.toContain('"b"');
    expect(files.text("/work/results.open.jsonl")).toBe("");
    const recorded = (await results.read())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).custom_id);
    expect(recorded).toEqual(["a", "b"]);
  });

  it("loads only its own shards: another stem, progress and stray files are not results", async () => {
    const files = memoryFiles({
      "/outputs/results-0001.jsonl": '{"custom_id":"a"}\n',
      "/outputs/results-0002.jsonl": '{"custom_id":"b"}\n',
      "/outputs/other-0001.jsonl": '{"custom_id":"other"}\n',
      "/outputs/results.jsonl": '{"custom_id":"legacy"}\n',
      "/outputs/results-1.jsonl": '{"custom_id":"short"}\n',
      "/outputs/results-0003.jsonl.tmp": '{"custom_id":"half"}\n',
      "/outputs/progress.json": '{"completed":99}',
      "/outputs/nested/results-0004.jsonl": '{"custom_id":"nested"}\n',
    });
    const results = new ResultShards(files, "/outputs", "/work", "results");

    expect(await results.sealed()).toEqual([
      "results-0001.jsonl",
      "results-0002.jsonl",
    ]);
    expect(await results.read()).toBe('{"custom_id":"a"}\n{"custom_id":"b"}\n');
    await results.append('{"custom_id":"c"}');
    expect(await results.seal()).toBe("results-0003.jsonl");
  });

  it("never writes a sealed shard again: a new run seals into the next number", async () => {
    const files = memoryFiles({
      "/outputs/results-0001.jsonl": '{"custom_id":"a"}\n',
      "/outputs/results-0007.jsonl": '{"custom_id":"b"}\n',
      "/outputs/progress.json": "{}",
    });
    const results = new ResultShards(files, "/outputs", "/work", "results");

    expect(await results.read()).toBe('{"custom_id":"a"}\n{"custom_id":"b"}\n');
    expect(await results.seal()).toBeNull();
    await results.append('{"custom_id":"c"}');
    expect(await results.seal()).toBe("results-0008.jsonl");
    expect(files.text("/outputs/results-0007.jsonl")).toBe(
      '{"custom_id":"b"}\n',
    );
  });

  it("reads the five-digit shards an earlier version sealed, and seals after them", async () => {
    const files = memoryFiles({
      "/outputs/results-00001.jsonl": '{"custom_id":"a"}\n',
      "/outputs/results-00002.jsonl": '{"custom_id":"b"}\n',
    });
    const results = new ResultShards(files, "/outputs", "/work", "results");

    expect(await results.read()).toBe('{"custom_id":"a"}\n{"custom_id":"b"}\n');
    await results.append('{"custom_id":"c"}');
    expect(await results.seal()).toBe("results-0003.jsonl");
    expect(await results.sealed()).toEqual([
      "results-00001.jsonl",
      "results-00002.jsonl",
      "results-0003.jsonl",
    ]);
  });

  it("starts no new line once stopped, and records the lines in flight", async () => {
    const files = memoryFiles({
      [INPUT]: jsonl(
        ...Array.from({ length: 6 }, (_, i) => ({
          custom_id: `c${i}`,
          prompt: `p${i}`,
        })),
      ),
    });
    const stop = new AbortController();
    const controller = new FakeController((prompt) => {
      if (prompt === "p0") stop.abort();
      return { status: "completed", output: "ok" };
    });
    const snapshots: string[] = [];

    const summary = await runBatchWith(
      {
        agent: "summarize",
        output_name: "results.jsonl",
        concurrency: 2,
        max_attempts: 1,
      },
      {
        controller: controllerOf(controller),
        files,
        input: INPUT,
        results: jsonlResults(files, OUTPUT),
        sleep: noSleep,
        signal: stop.signal,
        onProgress: async (progress) => {
          snapshots.push(
            `${progress.state}:${progress.completed}/${progress.remaining}`,
          );
        },
      },
    );

    expect(controller.started).toEqual(["p0", "p1"]);
    expect(summary).toMatchObject({ completed: 2, not_started: 4 });
    expect(snapshots.at(-1)).toBe("stopping:2/4");
    expect(snapshots[0]).toBe("running:0/6");
  });

  it("records lines still in flight at the cancel as failed, for the next run", async () => {
    const files = memoryFiles({
      [INPUT]: jsonl(
        { custom_id: "quick", prompt: "pq" },
        { custom_id: "slow", prompt: "ps" },
        { custom_id: "never", prompt: "pn" },
      ),
    });
    const stop = new AbortController();
    const cancel = new AbortController();
    const controller = {
      started: [] as string[],
      closed: [] as string[],
      async start(input: { prompt: string }) {
        this.started.push(input.prompt);
        return { agent_run_id: input.prompt };
      },
      async wait(id: string, signal?: AbortSignal) {
        if (id === "pq") {
          stop.abort();
          setTimeout(() => cancel.abort(), 1);
          return { agent_run_id: id, status: "completed", output: "ok" };
        }
        // The slow session never settles on its own.
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve()),
        );
        return { agent_run_id: id, status: "running" };
      },
      async close(id: string) {
        this.closed.push(id);
      },
      async message() {
        throw new Error("no follow-ups in this test");
      },
    };

    const summary = await runBatchWith(
      {
        agent: "summarize",
        output_name: "results.jsonl",
        concurrency: 2,
        max_attempts: 3,
      },
      {
        controller: controllerOf(controller),
        files,
        input: INPUT,
        results: jsonlResults(files, OUTPUT),
        sleep: noSleep,
        signal: stop.signal,
        cancel: cancel.signal,
      },
    );

    expect(summary).toMatchObject({
      completed: 1,
      failed: 1,
      not_started: 1,
      stopped: true,
    });
    expect(controller.started).toEqual(["pq", "ps"]);
    expect(controller.closed.sort()).toEqual(["pq", "ps"]);
    const slow = files
      .text(OUTPUT)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((r) => r.custom_id === "slow");
    expect(slow).toMatchObject({
      result: {
        type: "canceled",
        error: { message: expect.stringMatching(/stopped before/) },
      },
      batch: { attempts: 1 },
    });
    // A canceled line did not succeed, so a resumed run asks again.
    expect([...completedIds(files.text(OUTPUT)).keys()]).toEqual(["quick"]);
  });

  it("does not retry a rate-limited line once the run has stopped", async () => {
    const files = memoryFiles({
      [INPUT]: jsonl(
        { custom_id: "limited", prompt: "pl" },
        { custom_id: "ok", prompt: "po" },
        { custom_id: "later", prompt: "pz" },
      ),
    });
    const stop = new AbortController();
    const controller = new FakeController((prompt) => {
      if (prompt === "pl") {
        stop.abort();
        return {
          status: "failed",
          error: "provider returned 429 Too Many Requests",
        };
      }
      return { status: "completed", output: "ok" };
    });

    const summary = await runBatchWith(
      {
        agent: "summarize",
        output_name: "results.jsonl",
        concurrency: 2,
        max_attempts: 3,
      },
      {
        controller: controllerOf(controller),
        files,
        input: INPUT,
        results: jsonlResults(files, OUTPUT),
        sleep: noSleep,
        signal: stop.signal,
      },
    );

    // No retry of "pl" and no start of "pz" after the stop.
    expect(controller.started.filter((p) => p === "pl")).toHaveLength(1);
    expect(controller.started).not.toContain("pz");
    expect(summary).toMatchObject({
      failed: 1,
      completed: 1,
      not_started: 1,
      stopped: true,
    });
  });

  it("records a rate-limited attempt when the run stops during its backoff", async () => {
    const files = memoryFiles({
      [INPUT]: jsonl({ custom_id: "limited", prompt: "pl" }),
    });
    const stop = new AbortController();
    const controller = new FakeController(() => ({
      status: "failed",
      error: "provider returned 429 Too Many Requests",
    }));

    const summary = await runBatchWith(
      {
        agent: "summarize",
        output_name: "results.jsonl",
        concurrency: 1,
        max_attempts: 3,
      },
      {
        controller: controllerOf(controller),
        files,
        input: INPUT,
        results: jsonlResults(files, OUTPUT),
        // The stop lands while the line waits to retry.
        sleep: async () => stop.abort(),
        signal: stop.signal,
      },
    );

    expect(controller.started).toEqual(["pl"]);
    expect(summary).toMatchObject({ failed: 1, not_started: 0, stopped: true });
    const recorded = (files.text(OUTPUT) ?? "").trim().split("\n");
    expect(recorded).toHaveLength(1);
    expect(JSON.parse(recorded[0]).custom_id).toBe("limited");
  });

  it("keeps the attempt of a rate-limited line whose retry was waiting for capacity at the stop", async () => {
    const files = memoryFiles({
      [INPUT]: jsonl(
        { custom_id: "slow", prompt: "p0" },
        { custom_id: "limited", prompt: "p1" },
      ),
    });
    const stop = new AbortController();
    let release: () => void = () => {};
    const slowHeld = new Promise<void>((resolve) => (release = resolve));
    const controller = {
      started: [] as string[],
      async start(input: { prompt: string }) {
        this.started.push(input.prompt);
        return { agent_run_id: input.prompt };
      },
      async wait(id: string) {
        if (id === "p1") {
          // The rate limit halves the limiter to 1 while "slow" holds that
          // slot, so p1's retry waits in acquire(). The run stops before the
          // slot frees.
          setTimeout(() => {
            stop.abort();
            release();
          }, 5);
          return {
            agent_run_id: id,
            status: "failed",
            error: "429 Too Many Requests",
          };
        }
        await slowHeld;
        return { agent_run_id: id, status: "completed", output: "ok" };
      },
      async close() {},
      async message() {},
    };

    const summary = await runBatchWith(
      {
        agent: "summarize",
        output_name: "results.jsonl",
        concurrency: 2,
        max_attempts: 3,
      },
      {
        controller: controllerOf(controller),
        files,
        input: INPUT,
        results: jsonlResults(files, OUTPUT),
        sleep: noSleep,
        signal: stop.signal,
      },
    );

    expect(controller.started.filter((p) => p === "p1")).toHaveLength(1);
    // The attempt that ran is recorded as failed, never counted as not started.
    expect(summary).toMatchObject({ completed: 1, failed: 1, not_started: 0 });
    const limited = files
      .text(OUTPUT)
      .trim()
      .split("\n")
      .map((raw) => JSON.parse(raw))
      .find((line) => line.custom_id === "limited");
    expect(limited?.batch.attempts).toBe(1);
  });

  it("records nothing and starts nothing for an empty input", async () => {
    const files = memoryFiles({ [INPUT]: "" });
    const controller = new FakeController(() => ({
      status: "completed",
      output: "ok",
    }));

    const summary = await runBatchWith(
      {
        agent: "summarize",
        output_name: "results.jsonl",
        concurrency: 2,
        max_attempts: 1,
      },
      {
        controller: controllerOf(controller),
        files,
        input: INPUT,
        results: jsonlResults(files, OUTPUT),
        sleep: noSleep,
      },
    );

    expect(summary).toMatchObject({ total: 0, completed: 0, stopped: false });
    expect(controller.started).toEqual([]);
  });

  it("finishes with a snapshot that says so", async () => {
    const files = memoryFiles({
      [INPUT]: jsonl({ custom_id: "a", prompt: "pa" }),
    });
    const controller = new FakeController(() => ({
      status: "completed",
      output: "ok",
    }));
    const snapshots: BatchProgress[] = [];

    await runBatchWith(
      {
        agent: "summarize",
        output_name: "results.jsonl",
        concurrency: 1,
        max_attempts: 1,
      },
      {
        controller: controllerOf(controller),
        files,
        input: INPUT,
        results: jsonlResults(files, OUTPUT),
        sleep: noSleep,
        onProgress: async (progress) => {
          snapshots.push(progress);
        },
      },
    );

    expect(snapshots.at(-1)).toMatchObject({
      state: "finished",
      completed: 1,
      remaining: 0,
    });
  });
});

describe("resume by input fingerprint", () => {
  it("runs a completed line again when its prompt changed", async () => {
    const before = memoryFiles({
      [INPUT]: jsonl(
        { custom_id: "a", prompt: "first" },
        { custom_id: "b", prompt: "same" },
      ),
    });
    const params = {
      agent: "summarize",
      output_name: "results.jsonl",
      concurrency: 2,
      max_attempts: 1,
    };
    await runBatchWith(params, {
      controller: controllerOf(
        new FakeController(() => ({ status: "completed", output: "ok" })),
      ),
      files: before,
      input: INPUT,
      results: jsonlResults(before, OUTPUT),
      sleep: noSleep,
    });

    const after = memoryFiles({
      [INPUT]: jsonl(
        { custom_id: "a", prompt: "edited" },
        { custom_id: "b", prompt: "same" },
      ),
      [OUTPUT]: before.text(OUTPUT),
    });
    const controller = new FakeController(() => ({
      status: "completed",
      output: "ok",
    }));
    const summary = await runBatchWith(params, {
      controller: controllerOf(controller),
      files: after,
      input: INPUT,
      results: jsonlResults(after, OUTPUT),
      sleep: noSleep,
    });

    expect(controller.started).toEqual(["edited"]);
    expect(summary).toMatchObject({ already_completed: 1, completed: 1 });
  });
});

describe("AdaptiveLimiter", () => {
  it("halves on a rate limit and grows back after a run of successes", () => {
    const limiter = new AdaptiveLimiter(8, 2);
    limiter.onRateLimited();
    expect(limiter.currentLimit).toBe(4);
    limiter.onRateLimited();
    limiter.onRateLimited();
    limiter.onRateLimited();
    expect(limiter.currentLimit).toBe(1);
    limiter.onSuccess();
    limiter.onSuccess();
    expect(limiter.currentLimit).toBe(2);
  });
});

describe("batch params", () => {
  it("defaults concurrency, attempts and the results name", () => {
    const params = parseBatchParams({
      agent: "summarize",
    });
    expect(params).toMatchObject({
      concurrency: 8,
      max_attempts: 3,
      output_name: "results.jsonl",
    });
  });

  it("refuses unknown keys, a path as the output name and a bad concurrency", () => {
    expect(() => parseBatchParams(null)).toThrow(/invalid batch params/);
    expect(() =>
      parseBatchParams({ agent: "a", input_path: "p", extra: 1 }),
    ).toThrow(/invalid batch params/);
    expect(() =>
      parseBatchParams({ agent: "a", input_path: "p", output_name: "../x" }),
    ).toThrow(/output_name/);
    expect(() =>
      parseBatchParams({ agent: "a", input_path: "p", concurrency: 0 }),
    ).toThrow(/concurrency/);
  });
});

describe("node batch files", () => {
  it("appends durably and replaces a file atomically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "batch-files-"));
    const path = join(dir, "out", "results.jsonl");
    await nodeBatchFiles.appendLine(path, '{"custom_id":"a"}');
    await nodeBatchFiles.appendLine(path, '{"custom_id":"b"}');
    expect(await nodeBatchFiles.read(path)).toBe(
      '{"custom_id":"a"}\n{"custom_id":"b"}\n',
    );
    await nodeBatchFiles.write(path, "replaced\n");
    expect(await nodeBatchFiles.read(path)).toBe("replaced\n");
    expect(await nodeBatchFiles.list(join(dir, "out"))).toEqual([
      "results.jsonl",
    ]);
    expect(await nodeBatchFiles.read(join(dir, "missing"))).toBeNull();
  });
});

/** A full `AgentRunController`, as a host or Recipes' in-process controller would supply. */
class EchoRuns implements AgentRunController {
  private readonly runs = new Map<string, AgentRunSummary>();
  private counter = 0;

  list(): AgentRunSummary[] {
    return [...this.runs.values()];
  }
  get(id: string): AgentRunSummary | null {
    return this.runs.get(id) ?? null;
  }
  async start(input: { name: string; prompt: string; label?: string }) {
    const run = summary({ agent_run_id: `run-${++this.counter}` });
    this.runs.set(run.agent_run_id, { ...run, prompt: input.prompt });
    return run;
  }
  async wait(id: string) {
    const run = this.runs.get(id)!;
    const done = {
      ...run,
      status: "completed" as const,
      output: run.prompt.toUpperCase(),
    };
    this.runs.set(id, done);
    return done;
  }
  async message(id: string) {
    return this.runs.get(id)!;
  }
  async interrupt(id: string) {
    return this.runs.get(id)!;
  }
  async close(id: string) {
    const closed = { ...this.runs.get(id)!, status: "closed" as const };
    this.runs.set(id, closed);
    return closed;
  }
  async shutdown() {}
}

describe("runBatch", () => {
  it("runs a JSONL file in a directory, returns every result, and a second run resumes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "batch-run-"));
    await writeFile(
      join(dir, "prompts.jsonl"),
      jsonl(
        { custom_id: "a", prompt: "first", metadata: { source: "acme" } },
        { custom_id: "b", prompt: "second" },
      ),
    );

    const first = await runBatch({
      agent: "summarize",
      input: "prompts.jsonl",
      controller: new EchoRuns(),
      directory: dir,
    });
    expect(first).toMatchObject({ total: 2, completed: 2, failed: 0 });
    expect(
      first.results.map((line) => [line.custom_id, line.result.output]),
    ).toEqual([
      ["a", "FIRST"],
      ["b", "SECOND"],
    ]);
    expect(first.results[0].metadata).toEqual({ source: "acme" });
    const written = (await readFile(join(dir, "results.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(written).toHaveLength(2);

    const second = await runBatch({
      agent: "summarize",
      input: "prompts.jsonl",
      controller: new EchoRuns(),
      directory: dir,
    });
    expect(second).toMatchObject({ already_completed: 2, completed: 0 });
    expect(second.results).toHaveLength(2);
  });

  it("takes the lines themselves, with no files at all", async () => {
    const outcome = await runBatch({
      agent: "summarize",
      input: [
        { custom_id: "a", prompt: "first" },
        { custom_id: "b", prompt: "second" },
      ],
      controller: new EchoRuns(),
      concurrency: 2,
    });
    expect(outcome.results.map((line) => line.result.output)).toEqual([
      "FIRST",
      "SECOND",
    ]);
  });

  it("streams each result to onResult as its line finishes", async () => {
    const seen: string[] = [];
    await runBatch({
      agent: "summarize",
      input: [
        { custom_id: "a", prompt: "first" },
        { custom_id: "b", prompt: "second" },
      ],
      controller: new EchoRuns(),
      concurrency: 1,
      onResult: (result) => {
        seen.push(`${result.custom_id}:${result.result.output}`);
      },
    });
    expect(seen).toEqual(["a:FIRST", "b:SECOND"]);
  });

  it("returns the current input's results in its order, after a reorder or a removal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "batch-order-"));
    const a = { custom_id: "a", prompt: "first" };
    const b = { custom_id: "b", prompt: "second" };
    await runBatch({
      agent: "summarize",
      input: [a, b],
      controller: new EchoRuns(),
      directory: dir,
    });

    const reordered = await runBatch({
      agent: "summarize",
      input: [b, a],
      controller: new EchoRuns(),
      directory: dir,
    });
    expect(reordered.results.map((line) => line.custom_id)).toEqual(["b", "a"]);

    const reduced = await runBatch({
      agent: "summarize",
      input: [b],
      controller: new EchoRuns(),
      directory: dir,
    });
    expect(reduced.results.map((line) => line.custom_id)).toEqual(["b"]);
  });

  it("resumes past a results file whose last line a crash cut off", async () => {
    const dir = await mkdtemp(join(tmpdir(), "batch-torn-"));
    const input = [
      { custom_id: "a", prompt: "first" },
      { custom_id: "b", prompt: "second" },
    ];
    await runBatch({
      agent: "summarize",
      input,
      controller: new EchoRuns(),
      directory: dir,
    });
    const path = join(dir, "results.jsonl");
    const [first] = (await readFile(path, "utf8")).split("\n");
    // As a crash mid-append leaves it: one whole line, then half of the next.
    await writeFile(path, `${first}\n{"custom_id": "b", "res`);

    const resumed = await runBatch({
      agent: "summarize",
      input,
      controller: new EchoRuns(),
      directory: dir,
    });
    expect(resumed).toMatchObject({ already_completed: 1, completed: 1 });
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).custom_id)).toEqual(["a", "b"]);
  });

  it("refuses a repeated custom_id and an unknown option before any line runs", async () => {
    const controller = new EchoRuns();
    await expect(
      runBatch({
        agent: "summarize",
        input: [
          { custom_id: "a", prompt: "first" },
          { custom_id: "a", prompt: "again" },
        ],
        controller,
      }),
    ).rejects.toThrow(/input 2 repeats custom_id a/);
    await expect(
      runBatch({
        agent: "summarize",
        input: [{ custom_id: "a", prompt: "first" }],
        controller,
        // @ts-expect-error a misspelt option fails fast
        concurrenzy: 2,
      }),
    ).rejects.toThrow(/invalid batch params/);
  });
});

describe("cancellation with a controller whose wait rejects", () => {
  it("records the line in flight as canceled and still returns the summary", async () => {
    const files = memoryFiles({
      [INPUT]: jsonl({ custom_id: "slow", prompt: "p" }),
    });
    const cancel = new AbortController();
    const controller: BatchRunController = {
      async start() {
        return summary({ agent_run_id: "r1" });
      },
      wait(_id, signal) {
        cancel.abort();
        return Promise.reject(signal?.reason ?? new Error("wait aborted"));
      },
      async message() {
        return summary({ agent_run_id: "r1" });
      },
      async close() {
        return summary({ agent_run_id: "r1", status: "closed" });
      },
    };

    const outcome = await runBatchWith(
      parseBatchParams({ agent: "summarize", max_attempts: 1 }),
      {
        controller,
        files,
        input: INPUT,
        results: jsonlResults(files, OUTPUT),
        cancel: cancel.signal,
      },
    );

    expect(outcome.failed).toBe(1);
    const [line] = files
      .text(OUTPUT)
      .trim()
      .split("\n")
      .map((raw) => JSON.parse(raw));
    expect(line.result.type).toBe("canceled");
  });
});

describe("runBatch baggage", () => {
  it("runs each prompt inside baggage naming its conversation, plus the caller's entries", async () => {
    const teardown = useAsyncContext();
    try {
      const seen: Record<string, string>[] = [];
      const controller = new EchoRuns();
      const start = controller.start.bind(controller);
      controller.start = async (input) => {
        seen.push(activeBaggage());
        return start(input);
      };
      const dir = await mkdtemp(join(tmpdir(), "batch-baggage-"));
      const input = [
        { custom_id: "a", prompt: "first" },
        { custom_id: "b", prompt: "second" },
      ];

      const outcome = await runBatch({
        agent: "summarize",
        input,
        controller,
        directory: dir,
        concurrency: 1,
        baggage: (line) => ({ "acme.custom_id": line.custom_id }),
      });

      const ids = outcome.results.map((line) => line.result.conversation_id);
      expect(seen).toEqual([
        { "gen_ai.conversation.id": ids[0], "acme.custom_id": "a" },
        { "gen_ai.conversation.id": ids[1], "acme.custom_id": "b" },
      ]);
      expect(ids[0]).toMatch(/:0$/);
      expect(ids[1]).toMatch(/:1$/);

      // The same directory is the same batch: a resumed prompt keeps its conversation.
      input.push({ custom_id: "c", prompt: "third" });
      const resumed = await runBatch({
        agent: "summarize",
        input,
        controller,
        directory: dir,
      });
      const resumedIds = resumed.results.map(
        (line) => line.result.conversation_id,
      );
      expect(resumedIds.slice(0, 2)).toEqual(ids);
      expect(resumedIds[2]).toBe(`${ids[0]?.split(":")[0]}:2`);
    } finally {
      teardown();
    }
  });
});

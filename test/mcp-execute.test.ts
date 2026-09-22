import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callMcpDaemonTool: vi.fn(),
}));

vi.mock("../src/mcp-daemon-client.js", () => ({
  callMcpDaemonTool: mocks.callMcpDaemonTool,
}));

import { createMcpExecuteToolSet } from "../src/mcp-execute.js";
import type { McpExecuteDetails } from "../src/mcp-execute.js";
import { createRecipeToolSearch } from "../src/tool-search.js";
import type { McpSessionConfig } from "../src/mcp.js";
import {
  loadValidatedRecipeAgentDefinitions,
  type RecipeAgentMcp,
} from "../src/recipe-agent.js";

const session: McpSessionConfig = {
  version: 1,
  servers: [
    {
      id: "attio",
      name: "Attio",
      base_url: "https://example.test/mcp",
      package_tools: { include: ["*"] },
      agent_tools: [{ include: ["*"] }],
    },
  ],
};

const catalogs = [
  {
    id: "attio",
    name: "Attio",
    tools: [
      {
        name: "list_records",
        description: "List records of one object.",
        input_schema: {
          type: "object",
          properties: { object: { type: "string" } },
          required: ["object"],
        },
      },
      {
        name: "update_record",
        description: "Update one record.",
        input_schema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    ],
  },
];

const everything: RecipeAgentMcp = {
  mode: "execute",
  servers: { attio: { include: ["*"] } },
};

const readOnly: RecipeAgentMcp = {
  mode: "execute",
  servers: { attio: { include: ["list_records"] } },
};

function toolSet(mcp: RecipeAgentMcp, env: NodeJS.ProcessEnv = {}) {
  return createMcpExecuteToolSet({ session, catalogs, mcp, env });
}

async function run(
  set: ReturnType<typeof toolSet>,
  code: string,
  signal?: AbortSignal
): Promise<{ text: string; details: McpExecuteDetails }> {
  const execute = set.tools[0]!;
  const result = await (execute.execute as any)("call-1", { code }, signal, undefined);
  const text = (result.content as Array<{ type: string; text: string }>)
    .map((block) => block.text)
    .join("\n");
  return { text, details: result.details as McpExecuteDetails };
}

function structured(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

describe("mcp execute mode", () => {
  beforeEach(() => {
    mocks.callMcpDaemonTool.mockReset();
  });

  it("registers one tool whatever the catalog size", () => {
    const set = toolSet(everything);
    expect(set.toolNames).toEqual(["execute"]);
    expect(set.initialActiveToolNames).toEqual(["execute"]);
    expect(set.deferredToolNames).toEqual([]);
    expect(set.disclosed.map((tool) => tool.callable)).toEqual([
      "attio.list_records",
      "attio.update_record",
    ]);
  });

  it("composes several calls and returns only the program's value", async () => {
    mocks.callMcpDaemonTool
      .mockResolvedValueOnce(structured({ records: [{ id: "a" }, { id: "b" }] }))
      .mockResolvedValue(structured({ ok: true }));
    const { text, details } = await run(
      toolSet(everything),
      `const page = await attio.list_records({ object: "deals" });
       for (const record of page.records) await attio.update_record({ id: record.id });
       return { updated: page.records.length };`
    );
    expect(JSON.parse(text)).toEqual({ updated: 2 });
    expect(details.calls).toHaveLength(3);
    expect(details.calls.every((call) => call.ok)).toBe(true);
    expect(details.calls.map((call) => call.tool)).toEqual([
      "list_records",
      "update_record",
      "update_record",
    ]);
  });

  it("omits a tool the agent policy excludes, and refuses it by name", async () => {
    const set = toolSet(readOnly);
    expect(set.disclosed.map((tool) => tool.name)).toEqual(["attio.list_records"]);
    const { text } = await run(
      set,
      `return typeof (tools["attio"] ?? {}).update_record;`
    );
    expect(JSON.parse(text)).toBe("undefined");
    await expect(
      run(set, `return await tools["attio"].update_record({ id: "a" });`)
    ).rejects.toThrow(/not a function|not authorized/);
    expect(mocks.callMcpDaemonTool).not.toHaveBeenCalled();
  });

  it("validates arguments against the tool's input schema before any call", async () => {
    await expect(
      run(toolSet(everything), `return await attio.list_records({});`)
    ).rejects.toThrow(/inputSchema/);
    expect(mocks.callMcpDaemonTool).not.toHaveBeenCalled();
  });

  it("surfaces a provider error to the program's own try/catch", async () => {
    mocks.callMcpDaemonTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "rate limited" }],
    });
    const { text } = await run(
      toolSet(everything),
      `try { await attio.list_records({ object: "deals" }); return "unreachable"; }
       catch (error) { return { caught: error.message }; }`
    );
    expect(JSON.parse(text)).toEqual({ caught: "rate limited" });
  });

  it("reports how many calls ran when the program fails part-way", async () => {
    mocks.callMcpDaemonTool.mockResolvedValueOnce(structured({ ok: true }));
    await expect(
      run(
        toolSet(everything),
        `await attio.list_records({ object: "deals" });
         throw new Error("half done");`
      )
    ).rejects.toThrow(/half done[\s\S]*1 tool call\(s\) ran/);
  });

  it("enforces the per-program call budget", async () => {
    mocks.callMcpDaemonTool.mockResolvedValue(structured({ ok: true }));
    await expect(
      run(
        toolSet(everything, { PI_RECIPES_MCP_EXECUTE_MAX_CALLS: "2" }),
        `for (let i = 0; i < 5; i++) await attio.list_records({ object: "deals" });
         return "done";`
      )
    ).rejects.toThrow(/call budget/);
    expect(mocks.callMcpDaemonTool).toHaveBeenCalledTimes(2);
  });

  it("enforces the call budget against a parallel fan-out too", async () => {
    mocks.callMcpDaemonTool.mockImplementation(
      async () =>
        await new Promise((resolve) =>
          setTimeout(() => resolve(structured({ ok: true })), 20)
        )
    );
    await expect(
      run(
        toolSet(everything, { PI_RECIPES_MCP_EXECUTE_MAX_CALLS: "2" }),
        `const work = [];
         for (let i = 0; i < 6; i++) work.push(attio.list_records({ object: "deals" }));
         return (await Promise.allSettled(work)).map((entry) => entry.status);`
      )
    ).resolves.toBeDefined();
    expect(mocks.callMcpDaemonTool).toHaveBeenCalledTimes(2);
  });

  it("refuses to start a program on an already-cancelled turn", async () => {
    await expect(
      run(toolSet(everything), `return "ran";`, AbortSignal.abort())
    ).rejects.toThrow(/cancelled/);
    expect(mocks.callMcpDaemonTool).not.toHaveBeenCalled();
  });

  it("gives the program no host globals", async () => {
    const { text } = await run(
      toolSet(everything),
      `return { process: typeof process, fetch: typeof fetch, require: typeof require,
                importMeta: typeof globalThis.import, buffer: typeof Buffer };`
    );
    expect(JSON.parse(text)).toEqual({
      process: "undefined",
      fetch: "undefined",
      require: "undefined",
      importMeta: "undefined",
      buffer: "undefined",
    });
  });

  // `node:vm` is not a security boundary, so the boundary is the process the
  // program runs in. `sleep` is a host function, which is the escape hatch the
  // context cannot close; reach the runner's own realm through it and assert
  // that what it finds there is worthless. Both defences are checked because
  // either one alone would decay silently: the empty environment leaves nothing
  // to authenticate with, and the permission model leaves nothing to spawn.
  it("holds the boundary after a vm escape into the runner realm", async () => {
    const { text } = await run(
      toolSet(everything),
      `const Realm = sleep.constructor;
       const proc = Realm("return process")();
       let dynamicImport;
       try { await Realm("return import('node:child_process')")(); dynamicImport = "REACHABLE"; }
       catch (error) { dynamicImport = error.code ?? "blocked"; }
       return {
         envKeys: Object.keys(proc.env),
         permissionModel: typeof proc.permission?.has === "function",
         canSpawn: proc.permission?.has("child") ?? true,
         canStartWorker: proc.permission?.has("worker") ?? true,
         canReadSessionDir: proc.permission?.has("fs.read", "/") ?? true,
         dynamicImport,
       };`
    );
    expect(JSON.parse(text)).toEqual({
      envKeys: [],
      permissionModel: true,
      canSpawn: false,
      canStartWorker: false,
      canReadSessionDir: false,
      dynamicImport: "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING",
    });
  });

  it("terminates a program that outruns its wall clock", async () => {
    await expect(
      run(
        toolSet(everything, { PI_RECIPES_MCP_EXECUTE_TIMEOUT_MS: "300" }),
        `while (true) {}`
      )
    ).rejects.toThrow(/exceeded 300ms/);
  }, 15_000);

  it("captures console output alongside the returned value", async () => {
    const { text } = await run(
      toolSet(everything),
      `console.log("checked", 3); return "ok";`
    );
    expect(text).toContain("[log] checked 3");
    expect(text).toContain('"ok"');
  });
});

describe("tool search over an execute catalog", () => {
  it("returns signatures and activates nothing", async () => {
    const set = createMcpExecuteToolSet({
      session,
      catalogs,
      mcp: everything,
      env: {},
    });
    const active: string[] = [];
    const search = createRecipeToolSearch({
      tools: [],
      deferredToolNames: [],
      activation: {
        getActiveTools: () => active,
        setActiveTools: (names) => active.splice(0, active.length, ...names),
      },
      disclosed: set.disclosed,
    });
    expect(search).toBeDefined();
    const result = await (search!.execute as any)(
      "call-1",
      { query: "update a record" },
      undefined,
      undefined
    );
    const details = result.details as {
      added: string[];
      signatures: Array<{ callable: string }>;
    };
    expect(details.added).toEqual([]);
    expect(active).toEqual([]);
    expect(details.signatures[0]!.callable).toBe("attio.update_record");
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("attio.update_record(args)");
  });
});

describe("agent mcp mode parsing", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()!();
  });

  function fixture(agentMcp: string): string {
    const recipeDir = mkdtempSync(join(tmpdir(), "recipe-execute-"));
    cleanups.push(() => rmSync(recipeDir, { recursive: true, force: true }));
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "execute-mode-test",
        version: "0.1.0",
        pi: {
          agents: ["agents/*.yaml"],
          mcp: { servers: [{ id: "attio", tools: { include: ["*"] } }] },
        },
      })
    );
    mkdirSync(join(recipeDir, "agents"), { recursive: true });
    writeFileSync(
      join(recipeDir, "agents", "agent.yaml"),
      [
        "name: agent",
        "description: Test agent",
        "model:",
        "  name: test/provider-model",
        "tools:",
        "  - read",
        agentMcp,
      ].join("\n")
    );
    return recipeDir;
  }

  it("accepts execute and keeps it through resolution", () => {
    const recipeDir = fixture(
      ["mcp:", "  mode: execute", "  servers:", "    attio:", '      include: ["*"]'].join("\n")
    );
    const loaded = loadValidatedRecipeAgentDefinitions(recipeDir);
    expect(loaded.findings).toEqual([]);
    expect(loaded.definitions.get("agent")?.mcp?.mode).toBe("execute");
  });

  it("rejects activation selectors outside tools mode", () => {
    const recipeDir = fixture(
      [
        "mcp:",
        "  mode: execute",
        "  servers:",
        "    attio:",
        '      include: ["*"]',
        '      defer: ["*"]',
      ].join("\n")
    );
    const loaded = loadValidatedRecipeAgentDefinitions(recipeDir);
    expect(loaded.findings.length).toBeGreaterThan(0);
  });
});

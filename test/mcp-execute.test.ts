import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callMcpDaemonTool: vi.fn(),
}));

vi.mock("../src/mcp-daemon-client.js", () => ({
  callMcpDaemonTool: mocks.callMcpDaemonTool,
}));

import {
  createMcpExecuteToolSet,
  executeChildArgs,
  mcpExecuteChildPath,
  memoryBoundIsEnforced,
} from "../src/mcp-execute.js";
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

  // The runner is a build artifact resolved by path, so a build that stops
  // shipping it would otherwise surface as "exited (1) without a result".
  it("ships the program runner alongside the compiled output", () => {
    expect(existsSync(mcpExecuteChildPath())).toBe(true);
  });

  it("advertises bracket syntax for a server id that cannot be a bare global", () => {
    const reserved = createMcpExecuteToolSet({
      session: {
        ...session,
        servers: [
          { ...session.servers[0]!, id: "delete" },
          { ...session.servers[0]!, id: "sleep" },
        ],
      },
      catalogs: [
        { ...catalogs[0]!, id: "delete" },
        { ...catalogs[0]!, id: "sleep" },
      ],
      mcp: {
        mode: "execute",
        servers: { delete: { include: ["*"] }, sleep: { include: ["*"] } },
      } as RecipeAgentMcp,
      env: {},
    });
    // `delete` is a reserved word and `sleep` is one of the runner's own
    // globals; a bare-global form would send the model to a call that throws.
    expect(reserved.disclosed.map((tool) => tool.callable)).toEqual([
      'tools["delete"].list_records',
      'tools["delete"].update_record',
      'tools["sleep"].list_records',
      'tools["sleep"].update_record',
    ]);
  });

  it("installs a bare global whose name has setter semantics", async () => {
    // `__proto__` normalizes to a valid server id and the probe binds it fine,
    // but installing it by assignment runs Object.prototype's setter and binds
    // nothing — so the advertised bare call resolved to Object.prototype.
    mocks.callMcpDaemonTool.mockResolvedValue(structured({ ok: true }));
    const set = createMcpExecuteToolSet({
      session: {
        ...session,
        servers: [{ ...session.servers[0]!, id: "__proto__" }],
      },
      catalogs: [{ ...catalogs[0]!, id: "__proto__" }],
      mcp: {
        mode: "execute",
        // Computed, not literal: `{ __proto__: … }` would set the prototype
        // rather than declare a server, which is the same trap under test.
        servers: { ["__proto__"]: { include: ["*"] } },
      } as RecipeAgentMcp,
      env: {},
    });
    expect(set.disclosed.map((tool) => tool.callable)).toContain(
      "__proto__.list_records"
    );
    // The advertised form has to be the one that reaches the tool.
    const { details } = await run(
      set,
      `return await __proto__.list_records({ object: "deals" });`
    );
    expect(details.calls).toEqual([
      expect.objectContaining({ server: "__proto__", tool: "list_records", ok: true }),
    ]);
  }, 15_000);

  it("advertises bracket syntax for names the program's grammar forbids", () => {
    // The probe has to run in the grammar the program runs in: `await` is a
    // valid identifier at top level and a syntax error inside an async
    // function, and `arguments` binds to the wrapper's own arguments object.
    const grammar = createMcpExecuteToolSet({
      session: {
        ...session,
        servers: [
          { ...session.servers[0]!, id: "await" },
          { ...session.servers[0]!, id: "arguments" },
        ],
      },
      catalogs: [
        { ...catalogs[0]!, id: "await" },
        { ...catalogs[0]!, id: "arguments" },
      ],
      mcp: {
        mode: "execute",
        servers: { await: { include: ["*"] }, arguments: { include: ["*"] } },
      } as RecipeAgentMcp,
      env: {},
    });
    expect(grammar.disclosed.map((tool) => tool.callable)).toEqual([
      'tools["await"].list_records',
      'tools["await"].update_record',
      'tools["arguments"].list_records',
      'tools["arguments"].update_record',
    ]);
  });

  it("advertises bracket syntax for a name that cannot hold a binding", () => {
    // `undefined` is a valid normalized server id and a valid identifier, but
    // the binding is non-writable, so the bare form resolves to the primitive.
    const immutable = createMcpExecuteToolSet({
      session: { ...session, servers: [{ ...session.servers[0]!, id: "undefined" }] },
      catalogs: [{ ...catalogs[0]!, id: "undefined" }],
      mcp: {
        mode: "execute",
        servers: { undefined: { include: ["list_records"] } },
      } as RecipeAgentMcp,
      env: {},
    });
    expect(immutable.disclosed.map((tool) => tool.callable)).toEqual([
      'tools["undefined"].list_records',
    ]);
  });

  it("launches the runner under the permission model", () => {
    const args = executeChildArgs("/pkg/dist/mcp-execute-child.js", "/pkg/package.json", 512);
    expect(args[0]).toBe("--permission");
    expect(args).toContain("--max-old-space-size=512");
    expect(args).toContain("--allow-fs-read=/pkg/dist");
    expect(args).toContain("--allow-fs-read=/pkg/package.json");
    // Nothing else is granted: the session directory stays unreadable.
    expect(args.filter((arg) => arg.startsWith("--allow"))).toHaveLength(2);
  });

  it("caps a long description in the surface it sends every request", () => {
    const set = createMcpExecuteToolSet({
      session,
      catalogs: [
        {
          ...catalogs[0]!,
          tools: [
            {
              name: "list_records",
              description: "x".repeat(50_000),
              input_schema: { type: "object", properties: {} },
            },
          ],
        },
      ],
      mcp: everything,
      env: {},
    });
    // The surface ships in the tool definition, before `execute` is called.
    const description = set.tools[0]!.description ?? "";
    expect(description.length).toBeLessThan(5_000);
    expect(description).toContain("attio.list_records(args)");
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

  it("records a call the program started but never awaited", async () => {
    mocks.callMcpDaemonTool.mockImplementation(
      async () =>
        await new Promise((resolve) =>
          setTimeout(() => resolve(structured({ ok: true })), 200)
        )
    );
    const { details } = await run(
      toolSet(everything),
      `void attio.update_record({ id: "a" }); return "done";`
    );
    // The write reached the provider, so the outcome has to say so rather than
    // reporting success with an empty call list.
    expect(details.calls).toHaveLength(1);
    expect(details.calls[0]!.tool).toBe("update_record");
    expect(mocks.callMcpDaemonTool).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("cancels a call that outlives the drain rather than abandoning it", async () => {
    let aborted = false;
    mocks.callMcpDaemonTool.mockImplementation(
      async (_s: unknown, _t: unknown, _a: unknown, opts: { signal?: AbortSignal }) =>
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(structured({ ok: true })), 30_000);
          opts.signal?.addEventListener("abort", () => {
            aborted = true;
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        })
    );
    const { details } = await run(
      toolSet(everything, { PI_RECIPES_MCP_EXECUTE_DRAIN_MS: "200" }),
      `void attio.update_record({ id: "a" }); return "done";`
    );
    // The drain gave up, so the call must have been cancelled and recorded —
    // never left running against the provider with nothing said about it.
    expect(aborted).toBe(true);
    expect(details.calls).toHaveLength(1);
    expect(details.calls[0]!.ok).toBe(false);
  }, 20_000);

  it("clamps the failure text of a program that logged a large result", async () => {
    const { text } = await run(
      toolSet(everything, { PI_RECIPES_MCP_MAX_OUTPUT_BYTES: "400" }),
      `console.log("x".repeat(5000)); throw new Error("boom");`
    ).catch((error: Error) => ({ text: error.message }));
    expect(text).toContain("Output truncated");
    expect(text.length).toBeLessThan(1_500);
  });

  it("terminates a program whose output would exhaust the host", async () => {
    // The clamp on model-visible text runs after the frame is buffered and
    // parsed, so an enormous return value is a host-memory problem first.
    await expect(
      run(
        toolSet(everything),
        `return "x".repeat(9 * 1024 * 1024);`
      )
    ).rejects.toThrow(/more than \d+ bytes of output/);
  }, 30_000);

  // Windows has no RSS reader, so only the heap cap is left there — which this
  // program would walk straight past. Skipped rather than failed: the gap is
  // the platform's, and it is the same predicate the runner itself branches on.
  it.skipIf(!memoryBoundIsEnforced())("terminates a program that allocates past its memory bound", async () => {
    // Typed arrays live outside V8's heap, so `--max-old-space-size` does not
    // bound them (measured: 3 GiB RSS under a 64 MiB cap). The program also
    // never yields, so only a bound enforced from the parent can stop it.
    await expect(
      run(
        toolSet(everything, { PI_RECIPES_MCP_EXECUTE_MAX_MEMORY_MB: "128" }),
        `const keep = [];
         for (;;) keep.push(new Uint8Array(8 * 1024 * 1024).fill(1));`
      )
    ).rejects.toThrow(/exceeded 128MB of memory/);
  }, 30_000);

  it("tells the model when a cancelled call's remote outcome is unknown", async () => {
    // Cancellation reaches the daemon but not the provider, so an abandoned
    // write may still be running. The record carried that only in `details`,
    // where the model never sees it and reads the value as plain success.
    mocks.callMcpDaemonTool.mockImplementation(
      async (_s: unknown, _t: unknown, _a: unknown, opts: { signal?: AbortSignal }) =>
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(structured({ ok: true })), 30_000);
          opts.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            // The shape the daemon client actually throws when it detaches.
            reject(
              new Error(
                "MCP tool call 'attio.update_record' was cancelled; remote outcome is unknown; do not retry automatically."
              )
            );
          });
        })
    );
    const { text, details } = await run(
      toolSet(everything, { PI_RECIPES_MCP_EXECUTE_DRAIN_MS: "200" }),
      `void attio.update_record({ id: "1" }); return "done";`
    );
    expect(details.calls).toHaveLength(1);
    expect(text).toContain("remote outcome unknown");
    expect(text).toContain("attio.update_record");
  }, 20_000);

  it("names unresolved calls when the program itself fails", async () => {
    // A failed execution is the one most likely to be retried, so this path
    // needs the warning more than the success path does.
    mocks.callMcpDaemonTool.mockImplementation(
      async (_s: unknown, _t: unknown, _a: unknown, opts: { signal?: AbortSignal }) =>
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(structured({ ok: true })), 30_000);
          opts.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(
              new Error(
                "MCP tool call 'attio.update_record' was cancelled; remote outcome is unknown; do not retry automatically."
              )
            );
          });
        })
    );
    await expect(
      run(
        toolSet(everything, { PI_RECIPES_MCP_EXECUTE_DRAIN_MS: "200" }),
        `void attio.update_record({ id: "1" }); throw new Error("boom");`
      )
    ).rejects.toThrow(/remote outcome unknown[\s\S]*attio\.update_record/);
  }, 20_000);

  it("starts no provider call after the run has settled", async () => {
    // The child is killed at settlement, but stdout already queued still
    // arrives; servicing one of those frames would start a write after
    // cancellation, against a drain that has already been taken.
    mocks.callMcpDaemonTool.mockImplementation(
      async () => structured({ ok: true })
    );
    await expect(
      run(
        toolSet(everything, {
          PI_RECIPES_MCP_EXECUTE_TIMEOUT_MS: "400",
          PI_RECIPES_MCP_EXECUTE_MAX_CALLS: "100000",
          PI_RECIPES_MCP_EXECUTE_DRAIN_MS: "50",
        }),
        // Emits right up to the kill, so frames are still buffered when the
        // wall clock fires — which is what makes the race reachable at all.
        `for (let i = 0; i < 200000; i += 1) {
           void attio.list_records({ object: "deals" });
           if (i % 50 === 0) await sleep(1);
         }
         return "never";`
      )
    ).rejects.toThrow(/exceeded/);
    const atSettle = mocks.callMcpDaemonTool.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(mocks.callMcpDaemonTool.mock.calls.length).toBe(atSettle);
  }, 20_000);

  it("ignores a call frame coalesced behind done in one chunk", async () => {
    // A delayed microtask emits `call` after `done`, and both can land in a
    // single stdout read — so a per-chunk guard settles and then services the
    // write anyway.
    mocks.callMcpDaemonTool.mockResolvedValue(structured({ ok: true }));
    const { details } = await run(
      toolSet(everything, { PI_RECIPES_MCP_EXECUTE_MAX_CALLS: "1000" }),
      `for (let i = 0; i < 50; i += 1) {
         void Promise.resolve()
           .then(() => Promise.resolve())
           .then(() => attio.update_record({ id: String(i) }));
       }
       return "done";`
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Either the call was admitted before settling and is recorded, or it was
    // never started — never started-and-unreported.
    // An invariant, not a regression guard for the per-frame check: every
    // timing reachable here is already covered by the per-chunk guard, so this
    // passes with and without it. It still pins the property that matters —
    // a call is never started-and-unreported.
    expect(mocks.callMcpDaemonTool.mock.calls.length).toBe(details.calls.length);
  }, 20_000);

  it("does not hold the event loop after a program finishes", async () => {
    mocks.callMcpDaemonTool.mockResolvedValue(structured({ ok: true }));
    const started = Date.now();
    await run(
      toolSet(everything),
      `await attio.list_records({ object: "deals" }); return "done";`
    );
    // A drain deadline left scheduled would keep a one-shot process alive for
    // its full window after the result is already available.
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 15_000);

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
  // that what it finds there is worthless. The permission model itself is
  // asserted separately, on the spawn arguments — once `process` is gone the
  // program can no longer read `process.permission` to check it from inside.
  it("holds the boundary after a vm escape into the runner realm", async () => {
    const { text } = await run(
      toolSet(everything),
      `const Realm = sleep.constructor;
       const proc = Realm("return typeof process === 'undefined' ? undefined : process")();
       let dynamicImport;
       try { await Realm("return import('node:child_process')")(); dynamicImport = "REACHABLE"; }
       catch (error) { dynamicImport = error.code ?? "blocked"; }
       return {
         fetchInRealm: Realm("return typeof fetch")(),
         webSocketInRealm: Realm("return typeof WebSocket")(),
         processInRealm: Realm("return typeof process")(),
         builtinModule: Realm(
           "try { return typeof process.getBuiltinModule('node:http') } catch (e) { return e.constructor.name }"
         )(),
         socketViaConsole: Realm(
           "try { return console._stdout.constructor.name } catch (e) { return e.constructor.name }"
         )(),
         envKeys: proc === undefined ? [] : Object.keys(proc.env),
         dynamicImport,
       };`
    );
    expect(JSON.parse(text)).toEqual({
      fetchInRealm: "undefined",
      webSocketInRealm: "undefined",
      // Removing `process` takes `getBuiltinModule` with it, which is the
      // synchronous route to `node:http` that deleting `fetch` alone left open.
      processInRealm: "undefined",
      builtinModule: "ReferenceError",
      // `console._stdout.constructor` is `net.Socket`, and it connects under
      // `--permission` — a retained stream object is a capability root too.
      socketViaConsole: "ReferenceError",
      envKeys: [],
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

  it("bounds a schema whose fallback is itself oversized", async () => {
    // The fallback exists because the schema was already too large; a schema
    // with thousands of properties would route around that same limit.
    const wide = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 2_000 }, (_, index) => [
          `property_number_${index}`,
          { type: "string" },
        ])
      ),
      required: Array.from({ length: 2_000 }, (_, index) => `property_number_${index}`),
    };
    const set = createMcpExecuteToolSet({
      session,
      catalogs: [
        {
          ...catalogs[0]!,
          tools: [
            { name: "list_records", description: "list records", input_schema: wide },
          ],
        },
      ],
      mcp: everything,
      env: {},
    });
    const search = createRecipeToolSearch({
      tools: [],
      deferredToolNames: [],
      activation: { getActiveTools: () => [], setActiveTools: () => {} },
      disclosed: set.disclosed,
    });
    const result = await (search!.execute as any)(
      "call-1",
      { query: "list records" },
      undefined,
      undefined
    );
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("more");
    expect(text.length).toBeLessThan(2_000);
  });

  it("clamps a long description in a search disclosure", async () => {
    // Sibling of the execute-surface cap: the schema beside these was already
    // bounded, so leaving the prose unbounded routed around that.
    const set = createMcpExecuteToolSet({
      session,
      catalogs: [
        {
          ...catalogs[0]!,
          tools: [
            {
              name: "list_records",
              description: `list records ${"y".repeat(50_000)}`,
              input_schema: { type: "object", properties: {} },
            },
          ],
        },
      ],
      mcp: everything,
      env: {},
    });
    const search = createRecipeToolSearch({
      tools: [],
      deferredToolNames: [],
      activation: { getActiveTools: () => [], setActiveTools: () => {} },
      disclosed: set.disclosed,
    });
    const result = await (search!.execute as any)(
      "call-1",
      { query: "list records" },
      undefined,
      undefined
    );
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("attio.list_records(args)");
    expect(text.length).toBeLessThan(2_000);
  });

  it("keeps tool_search for an execute catalog with nothing to disclose", async () => {
    // Execute mode documents a two-tool surface, so a skill calling
    // `tool_search` should get a no-match answer, not an unavailable tool.
    const search = createRecipeToolSearch({
      tools: [],
      deferredToolNames: [],
      activation: { getActiveTools: () => [], setActiveTools: () => {} },
      disclosed: [],
      alwaysRegister: true,
    });
    expect(search).toBeDefined();
    const result = await (search!.execute as any)(
      "call-1",
      { query: "anything" },
      undefined,
      undefined
    );
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain(
      "No inactive Recipe tools matched"
    );
  });

  it("spends one limit across both catalogs", async () => {
    // Ranking each kind separately returned `limit` of each, so the caller got
    // twice what it asked for and deferred tools were activated that were not
    // among the best `limit` overall.
    const set = createMcpExecuteToolSet({
      session,
      catalogs,
      mcp: everything,
      env: {},
    });
    const deferredTools = ["record_lookup", "record_notes", "record_export"].map(
      (name) => ({ name, description: `record ${name}` })
    );
    const active: string[] = [];
    const search = createRecipeToolSearch({
      tools: deferredTools,
      deferredToolNames: deferredTools.map((tool) => tool.name),
      activation: {
        getActiveTools: () => active,
        setActiveTools: (names) => active.splice(0, active.length, ...names),
      },
      disclosed: set.disclosed,
    });
    const result = await (search!.execute as any)(
      "call-1",
      { query: "record", limit: 2 },
      undefined,
      undefined
    );
    const details = result.details as {
      added: string[];
      matches: Array<{ name: string }>;
      signatures: Array<{ callable: string }>;
    };
    expect(details.matches.length + details.signatures.length).toBe(2);
    // Whatever ranked, activation never exceeds the limit either.
    expect(details.added).toEqual(details.matches.map((match) => match.name));
    expect(active).toEqual(details.added);
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

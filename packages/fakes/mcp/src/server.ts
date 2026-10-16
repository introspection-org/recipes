import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  type Implementation,
  type McpHttpHandler,
  McpServer,
} from "@modelcontextprotocol/server";
import { type Configured, configuredBy } from "./config.js";

/**
 * `T` as a JSON import types it: every string literal widened to `string`, so a manifest
 * imported from JSON is assignable without a cast. The host checks the values that matter.
 */
export type Widened<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? Widened<U>[]
    : T extends object
      ? { [K in keyof T]: Widened<T[K]> }
      : T;

const THEMES = ["light", "dark"];

/** The fields of a fake's `manifest.json` the host reads. */
export interface Manifest {
  /** The name and version the fake answers in `initialize`. */
  server: Widened<Implementation>;
  /** The tools the Recipe allows, each with its kind and the entities it reads and writes. */
  tools: Record<string, unknown>;
}

/** One fake, as its `index.ts` exports it. */
export interface Fake {
  manifest: Manifest;
  register: (server: McpServer, state: never) => void;
}

/** Every fake of a Recipe, keyed by the server id it is served under. */
export type Fakes = Record<string, Fake>;

export interface ServiceOptions<W extends object> {
  /** The Recipe's `world(scenario, clock)`: every fake's starting state, keyed by fake id. */
  world: (scenario: string | undefined, clock: Date) => W;
  /** The scenario `world` builds; `world`'s own default when omitted. */
  scenario?: string;
  /** The clock `world` computes every date from; now when omitted. */
  clock?: Date | string;
  /** The port to listen on; an ephemeral one when omitted or 0. */
  port?: number;
  /** The address to listen on; loopback when omitted. */
  host?: string;
  /** A file every fake's state is written to, keyed by fake id, after each MCP request. */
  stateFile?: string;
  /** A file each tool call is appended to as one JSON line. */
  record?: string;
}

/** A fake's MCP binding, in the shape a Recipe's `.pi/mcp.local.json` lists its servers. */
export type McpServerBinding = { id: string; transport: "streamable_http"; url: string };

export interface Services<W> {
  server: http.Server;
  port: number;
  /** A fake's MCP endpoint. */
  url: (id: string) => string;
  /** Every fake's MCP binding, in the order of `fakes`. */
  mcpServers: () => McpServerBinding[];
  /** Every fake's current state, which the handlers change in place. */
  states: W;
  /** Every fake's state when the services started. */
  initial: W;
  close: () => Promise<void>;
}

/** One recorded call, in the line shape `introspection bindings mcp observe --examples` writes. */
export interface RecordedCall {
  server: string;
  tool: string;
  args: unknown;
  result: unknown;
}

// A JSON-RPC response in either body shape the SDK answers with: JSON, or one SSE event.
function answer(body: string, id: unknown): Record<string, unknown> | undefined {
  const parse = (text: string) => {
    try {
      return [JSON.parse(text)];
    } catch {
      return [];
    }
  };
  const events = body.split("\n").filter((line) => line.startsWith("data:"));
  const messages = events.length ? events.flatMap((line) => parse(line.slice(5))) : parse(body);
  const all = messages.flat() as Record<string, unknown>[];
  return all.find((message) => message?.id === id) ?? all.find((message) => message?.error);
}

// Appends each tools/call and its answer to `file`. The answer is buffered and written before
// the response goes out, so a caller that has its answer can read the line.
function recording(handler: McpHttpHandler, id: string, file: string) {
  return {
    async fetch(request: Request, options?: Parameters<McpHttpHandler["fetch"]>[1]) {
      if (request.method !== "POST") return handler.fetch(request, options);
      let call: { id?: unknown; method?: unknown; params?: { name?: string; arguments?: unknown } };
      try {
        call = JSON.parse(await request.clone().text());
      } catch {
        return handler.fetch(request, options);
      }
      const response = await handler.fetch(request, options);
      if (call?.method !== "tools/call") return response;
      const body = await response.text();
      const message = answer(body, call.id);
      if (message) {
        const line: RecordedCall = {
          server: id,
          tool: String(call.params?.name),
          args: call.params?.arguments ?? {},
          result: "result" in message ? message.result : { error: message.error },
        };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
      }
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  };
}

// The manifest's server as the SDK types it, once the one field `Widened` loosens is a value it allows.
function manifestServer(id: string, fake: Fake): Implementation {
  const { server } = fake.manifest;
  for (const icon of server.icons ?? [])
    if (icon.theme !== undefined && !THEMES.includes(icon.theme))
      throw new Error(`The ${id} manifest's server icon theme ${icon.theme} is not light or dark`);
  return server as Implementation;
}

// The host refuses to start unless a fake's handlers register exactly the tools its manifest
// allows, each from `config(name)`, in the order `tools.json` gives them.
function checkRegistrations(id: string, fake: Fake, info: Implementation, state: unknown) {
  const server = new McpServer(info);
  const registered: { name: string; from?: Configured }[] = [];
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  Object.assign(server, {
    registerTool: (name: string, config: object, ...rest: unknown[]) => {
      registered.push({ name, from: configuredBy(config) });
      return register(name, config, ...rest);
    },
  });
  fake.register(server, state as never);
  const problems: string[] = [];
  for (const { name, from } of registered)
    if (!from || from.name !== name)
      problems.push(`${name} is not registered with config('${name}')`);
  const names = registered.map((tool) => tool.name);
  const allowed = Object.keys(fake.manifest.tools);
  problems.push(
    ...allowed.filter((name) => !names.includes(name)).map((name) => `missing ${name}`),
    ...names.filter((name) => !allowed.includes(name)).map((name) => `not allowed ${name}`),
  );
  const order = registered.flatMap(({ from }) => (from ? [from.index] : []));
  if (order.some((index, i) => i > 0 && index < order[i - 1]))
    problems.push(`registered as ${names.join(", ")}, not in the order of tools.json`);
  if (problems.length)
    throw new Error(
      `The ${id} handlers do not register the tools its manifest allows: ${problems.join(", ")}`,
    );
}

function writeAtomically(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Serves every fake on one HTTP server: its MCP endpoint at `/<id>/mcp`, its current state at
 * `/<id>/admin/state` and the state it started with at `/<id>/admin/initial-state`.
 */
export async function startServices<W extends object>(
  fakes: Fakes,
  options: ServiceOptions<W>,
): Promise<Services<W>> {
  const { world, scenario, clock, port = 0, host = "127.0.0.1", stateFile, record } = options;
  const seeded = world(scenario, new Date(clock ?? Date.now())) as Record<string, unknown>;
  const served = Object.entries(fakes).map(([id, fake]) => {
    if (!Object.hasOwn(seeded, id)) throw new Error(`The world has no state for the fake ${id}`);
    const initial = structuredClone(seeded[id]);
    const state = structuredClone(initial);
    const info = manifestServer(id, fake);
    checkRegistrations(id, fake, info, state);
    const handler = createMcpHandler(() => {
      const server = new McpServer(info);
      fake.register(server, state as never);
      return server;
    });
    return {
      id,
      handler,
      mcp: toNodeHandler(record ? recording(handler, id, record) : handler),
      initial,
      state,
    };
  });
  const states = Object.fromEntries(served.map((fake) => [fake.id, fake.state])) as W;
  const initial = Object.fromEntries(served.map((fake) => [fake.id, fake.initial])) as W;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const [, id, ...rest] = url.pathname.split("/");
      const fake = served.find((item) => item.id === id);
      const route = rest.join("/");
      if (fake && route === "mcp") {
        // The adapter resolves once it has ended the response; the write is synchronous, so a
        // concurrent request cannot interleave with it.
        await fake.mcp(req, res);
        if (stateFile) writeAtomically(stateFile, states);
        return;
      }
      let result: unknown;
      if (url.pathname === "/health") result = { ok: true };
      else if (fake && route === "admin/state") result = fake.state;
      else if (fake && route === "admin/initial-state") result = fake.initial;
      else {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      // A state write that fails after the response was sent stops the host.
      if (res.headersSent) throw error;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: (error as Error).message }));
    }
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const actual = (server.address() as { port: number }).port;
  const reach = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const url = (id: string) => `http://${reach}:${actual}/${id}/mcp`;
  return {
    server,
    port: actual,
    url,
    mcpServers: () =>
      served.map(({ id }) => ({ id, transport: "streamable_http" as const, url: url(id) })),
    states,
    initial,
    async close() {
      for (const fake of served) await fake.handler.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

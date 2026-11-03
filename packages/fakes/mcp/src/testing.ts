// The helpers of a Recipe's contract tests: fresh fakes with an official MCP client each, and
// tool calls whose successful answers are held to the fake's contract. A subpath of its own, so
// the host's import path never loads @modelcontextprotocol/client.
import fs from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { readResult } from "./answers.js";
import type { Contract } from "./contract.js";
import { type Fakes, type Services, startServices } from "./server.js";

const contractOf = new WeakMap<Client, Contract>();

/** An official MCP client connected to one fake of `services`. */
export async function connect(services: Services<object>, id: string): Promise<Client> {
  const fake = services.fakes[id];
  if (!fake) throw new Error(`No fake ${id} is served`);
  const client = new Client({ name: "mcp-fakes-testing", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(services.url(id))));
  contractOf.set(client, fake.contract);
  return client;
}

/** A tool call's text items, joined, its error flag, and its structuredContent. */
export interface Called {
  text: string;
  isError: boolean;
  structured?: unknown;
}

/**
 * Calls a tool. A tool error, such as a schema rejection, is a result; a call to a tool the fake
 * does not serve rejects with the JSON-RPC error. A successful answer must be the tool's contract
 * answer, read from its structuredContent where it states an outputSchema and from its text
 * otherwise, or the call throws.
 */
export async function callTool(client: Client, name: string, args: object = {}): Promise<Called> {
  const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
  const content = (result.content ?? []) as { type: string; text?: string }[];
  const text = content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  const structured = result.structuredContent;
  const isError = result.isError === true;
  const contract = contractOf.get(client);
  if (!isError && contract) {
    const entry = contract[name];
    const read = entry
      ? readResult(entry, { text, structured })
      : ({ ok: false, error: "not in its contract" } as const);
    if (!read.ok) throw new Error(`${name} answered outside its contract: ${read.error}`);
  }
  return { text, isError, ...(structured !== undefined && { structured }) };
}

/** Calls a tool and gives its text; a tool error throws with its text. */
export async function call(client: Client, name: string, args?: object): Promise<string> {
  const result = await callTool(client, name, args);
  if (result.isError) throw new Error(result.text);
  return result.text;
}

export interface WithFakesOptions {
  /** The clock the world is built at; a fixed one keeps a recording stable. Now when omitted. */
  clock?: Date | string;
  /** A file each tool call is appended to, for `checkRecipeFakes`' `recording`. */
  record?: string;
}

/** What `withFakes` hands the test: a connected client per fake id, the states and the services. */
export type Connected<W extends object> = Record<string, Client> & {
  states: W;
  services: Services<W>;
};

/** Fresh fakes for a scenario, with a connected client per fake, closed afterwards. */
export async function withFakes<W extends object, T>(
  fakes: Fakes,
  world: (scenario: string | undefined, clock: Date) => W,
  scenario: string | undefined,
  fn: (connected: Connected<W>) => Promise<T> | T,
  options: WithFakesOptions = {},
): Promise<T> {
  const services = await startServices(fakes, { world, scenario, ...options });
  const clients: Record<string, Client> = {};
  try {
    for (const id of Object.keys(fakes)) clients[id] = await connect(services, id);
    return await fn({ ...clients, states: services.states, services } as Connected<W>);
  } finally {
    for (const client of Object.values(clients)) await client.close();
    await services.close();
  }
}

/**
 * The global setup and teardown of a test run that records its answers to `file`, as
 * `node --test --test-global-setup` and vitest's `globalSetup` take them: the recording is
 * emptied before the run and sorted after, so a committed one does not change with the order the
 * test files ran in. `export const { globalSetup, globalTeardown } = recording(RECORD);`
 */
export function recording(file: string) {
  return {
    globalSetup() {
      fs.rmSync(file, { force: true });
    },
    globalTeardown() {
      if (!fs.existsSync(file)) return;
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).sort();
      fs.writeFileSync(file, lines.length ? `${lines.join("\n")}\n` : "");
    },
  };
}

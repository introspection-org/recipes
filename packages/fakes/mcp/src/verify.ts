import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

// Imports only Node built-ins, so a Recipe's eval harness and judges can use it without the
// host's MCP SDK, esbuild or a test runner. A test holds it to that.

/** Each fake's state, keyed by fake id, when the services started and after the run. */
export type FakeStates<TStates = Record<string, unknown>> = {
  initial: TStates;
  final: TStates;
};

/** The fields of a fake's `manifest.json` the checks read: its write map. */
export type WriteMap = {
  tools: Record<string, { writes?: string[] }>;
};

/** A tool call to a write tool, with the fake it went to and the tool's name in its contract. */
export type WriteAttempt<TCall> = TCall & { server: string; tool: string };

const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Each fake's `manifest.json` under `directory`, keyed by fake id: one
 * directory per fake, named by its id, as the Recipe's `fakes/mcp/` holds them.
 * A missing directory or one without a manifest throws, so a check whose
 * manifests are missing cannot pass.
 */
export function loadManifests(directory: string): Record<string, WriteMap> {
  if (!existsSync(directory) || !statSync(directory).isDirectory())
    throw new Error(`No fakes' manifest directory at ${directory}`);
  const manifests = Object.fromEntries(
    readdirSync(directory)
      .sort()
      .filter((id) => existsSync(join(directory, id, "manifest.json")))
      .map((id) => [
        id,
        JSON.parse(readFileSync(join(directory, id, "manifest.json"), "utf8")) as WriteMap,
      ]),
  );
  if (!Object.keys(manifests).length) throw new Error(`No fake's manifest.json under ${directory}`);
  return manifests;
}

const writeTools = (manifest: WriteMap) =>
  Object.entries(manifest.tools)
    .filter(([, tool]) => tool.writes?.length)
    .map(([name]) => name);

const writtenEntities = (manifest: WriteMap) => [
  ...new Set(Object.values(manifest.tools).flatMap((tool) => tool.writes ?? [])),
];

/**
 * "No state changed": `<fake>.<entity>` for every entity some tool of these
 * fakes writes whose final state differs from the initial one. Outbound
 * effects, such as sent emails and rejected send attempts, are entities too.
 * A rejected write or a no-op call is no change, and a change undone within
 * the run is not seen. No manifests throws rather than reports no change.
 */
export function changedEntities(
  states: FakeStates<object>,
  manifests: Record<string, WriteMap>,
): string[] {
  if (!Object.keys(manifests).length) throw new Error("No fakes' manifests to check");
  return Object.entries(manifests).flatMap(([fake, manifest]) => {
    const initial = record((states.initial as Record<string, unknown>)[fake]);
    const final = record((states.final as Record<string, unknown>)[fake]);
    if (!initial || !final) throw new Error(`The states hold no state for the fake ${fake}`);
    return writtenEntities(manifest)
      .filter((entity) => !isDeepStrictEqual(initial[entity], final[entity]))
      .map((entity) => `${fake}.${entity}`);
  });
}

function sanitizedNamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "") || "tool";
}

/** The names Pi gives an MCP server's tool: hashed, and the readable form without the hash. */
export function piToolNames(server: string, tool: string): string[] {
  const digest = createHash("sha256").update(`${server}.${tool}`).digest("hex").slice(0, 10);
  const readable = `mcp_${sanitizedNamePart(server)}_${sanitizedNamePart(tool)}`;
  const prefix = readable.slice(0, 64 - digest.length - 1).replace(/_+$/, "");
  return [`${prefix}_${digest}`, readable];
}

/**
 * "No write attempted" is an attempt check, not a state check: the calls
 * among `calls` to a tool these fakes' write maps say writes, whether or not
 * the call changed anything. `calls` are the run's tool calls under Pi's
 * names, such as vitest-evals' `toolCalls(run.session)`; a server is matched
 * by the fake's id, which is the server id the Recipe declares and Pi names
 * the tool by. No manifests throws rather than reports no attempt.
 */
export function writeAttempts<TCall extends { name: string }>(
  calls: readonly TCall[],
  manifests: Record<string, WriteMap>,
): WriteAttempt<TCall>[] {
  if (!Object.keys(manifests).length) throw new Error("No fakes' manifests to check");
  const names = new Map<string, { server: string; tool: string }>();
  for (const [fake, manifest] of Object.entries(manifests))
    for (const tool of writeTools(manifest))
      for (const name of piToolNames(fake, tool)) names.set(name, { server: fake, tool });
  return calls.flatMap((call) => {
    const target = names.get(call.name);
    return target ? [{ ...call, ...target }] : [];
  });
}

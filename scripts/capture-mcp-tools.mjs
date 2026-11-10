#!/usr/bin/env node
// Writes each MCP server's whole `tools/list` (every page) to one JSON file,
// for test fixtures: `node scripts/capture-mcp-tools.mjs <out.json> <url>...`.
// It speaks Streamable HTTP with no credential, so it is for public servers.
import { writeFileSync } from "node:fs";

const [out, ...urls] = process.argv.slice(2);
if (!out || urls.length === 0) {
  console.error(
    "Usage: node scripts/capture-mcp-tools.mjs <out.json> <url>...",
  );
  process.exit(64);
}
let url;
let session;
let id = 0;

async function rpc(method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  session ??= response.headers.get("mcp-session-id") ?? undefined;
  const text = await response.text();
  const body = response.headers.get("content-type")?.includes("event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5)))
        .find((message) => message.id === id)
    : JSON.parse(text);
  if (!response.ok || body?.error)
    throw new Error(
      `${method}: ${response.status} ${JSON.stringify(body?.error ?? text)}`,
    );
  return body.result;
}

/** One server's `serverInfo` and every tool it lists. */
async function capture() {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "recipes-fixture", version: "1" },
  });
  await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });
  const tools = [];
  let cursor;
  do {
    const page = await rpc("tools/list", cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return { url, serverInfo: init.serverInfo, tools };
}

const servers = [];
for (url of urls) {
  session = undefined;
  servers.push(await capture());
  console.log(`${servers.at(-1).tools.length} tools from ${url}`);
}
writeFileSync(out, `${JSON.stringify({ servers }, null, 2)}\n`);

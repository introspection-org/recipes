import { mkdtempSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadRecipeProductivity } from "../src/productivity/index.js";
import { readPiPackageManifest } from "../src/recipe/package.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

const b64 = (text: string) => Buffer.from(text).toString("base64url");

const MESSAGE = {
  id: "18c2f0a1",
  threadId: "18c2f0a0",
  labelIds: ["INBOX", "UNREAD", "Label_7"],
  snippet: "Quarterly numbers",
  internalDate: "1762250400000",
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: "Ada <ada@example.com>" },
      { name: "To", value: "person@example.com" },
      { name: "Subject", value: "Hi" },
    ],
    body: { data: b64("Hello") },
  },
};

const requests: Array<{ method: string; path: string }> = [];

/** Google's REST APIs for the calls `mail search` makes; anything else, including the MCP servers, is a 404. */
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  req.resume();
  req.on("end", () => {
    const path = new URL(req.url!, "http://fake").pathname;
    requests.push({ method: req.method!, path });
    const reply =
      req.method === "GET" && path === "/gmail/v1/users/me/messages"
        ? { messages: [{ id: MESSAGE.id, threadId: MESSAGE.threadId }] }
        : req.method === "GET" &&
            path === `/gmail/v1/users/me/messages/${MESSAGE.id}`
          ? MESSAGE
          : req.method === "GET" && path === "/gmail/v1/users/me/labels"
            ? { labels: [{ id: "Label_7", name: "Clients", type: "user" }] }
            : undefined;
    res.writeHead(reply ? 200 : 404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        reply ?? { error: { code: 404, errors: [{ reason: "notFound" }] } },
      ),
    );
  });
});

let base = "";
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("Google productivity provider: through the host", () => {
  it("loads as the companion beside Recipes and serves mail with handles through a host's fetch hook", async () => {
    const recipeDir = mkdtempSync(
      join(tmpdir(), "productivity-google-recipe-"),
    );
    writeFileSync(
      join(recipeDir, "package.json"),
      JSON.stringify({
        name: "r",
        version: "0.1.0",
        type: "module",
        pi: {
          productivity: [
            { provider: "google", tools: { mail: ["search", "read"] } },
          ],
        },
      }),
    );
    const seen: Array<{ host: string; authorization: string }> = [];
    const loaded = await loadRecipeProductivity(
      readPiPackageManifest(recipeDir).productivity!,
      ["mail"],
      {
        recipeDir,
        env: {},
        cwd: recipeDir,
        // A host's request hook: it would attach the person's credential here.
        fetch: (url, init) => {
          const target = new URL(url);
          const headers = new Headers(init.headers as HeadersInit);
          seen.push({
            host: target.host,
            authorization: headers.get("Authorization") ?? "",
          });
          return fetch(
            `${base}${target.pathname}${target.search}`,
            init as RequestInit,
          );
        },
      },
    );
    const pi = createMockExtensionAPI();
    await loaded.extension!.factory(pi as never);
    const result = (await pi.tools
      .get("mail")!
      .execute(
        "c",
        { command: "search" } as never,
        undefined,
        undefined,
        undefined as never,
      )) as {
      details: {
        messages: Array<{ message: string; subject: string; labels: string[] }>;
      };
    };
    expect(result.details.messages).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/^msg_/),
        subject: "Hi",
        labels: ["INBOX", "UNREAD", "Clients"],
      }),
    ]);
    // Gmail's MCP server answered nothing here, so search fell back to REST.
    expect(seen.map((call) => call.host)).toContain("gmailmcp.googleapis.com");
    expect(requests).toContainEqual({
      method: "GET",
      path: "/gmail/v1/users/me/messages",
    });
    expect(new Set(seen.map((call) => call.authorization))).toEqual(
      new Set(["Bearer introspection-egress"]),
    );
  });
});

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

/** Google's REST APIs for the calls `mail search` makes; anything else is a 404. */
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
    // Pi ran no other tool for this call, so search was served over REST.
    expect(seen.map((call) => call.host)).not.toContain(
      "gmailmcp.googleapis.com",
    );
    expect(requests).toContainEqual({
      method: "GET",
      path: "/gmail/v1/users/me/messages",
    });
    expect(new Set(seen.map((call) => call.authorization))).toEqual(
      new Set(["Bearer introspection-egress"]),
    );

    // With Pi's `ctx.executeTool`, mail read goes to the Recipe's Gmail MCP
    // server through it, under the name Pi gives that server's tool.
    const nested: Array<{ name: string; args: unknown }> = [];
    const toolContext = {
      tools: [{ name: "mcp__gmail__get_message" }],
      executeTool: async (name: string, args: unknown) => {
        nested.push({ name, args });
        const result = { content: [], structuredContent: { message: MESSAGE } };
        return {
          isError: false,
          result: { content: [], structuredContent: result },
        };
      },
    };
    const before = requests.length;
    const read = (await pi.tools.get("mail")!.execute(
      "c2",
      {
        command: "read",
        message: result.details.messages[0]!.message,
      } as never,
      undefined,
      undefined,
      toolContext as never,
    )) as { details: { messages: Array<{ subject: string }> } };
    expect(read.details.messages[0]!.subject).toBe("Hi");
    expect(nested).toEqual([
      { name: "mcp__gmail__get_message", args: { messageId: MESSAGE.id } },
    ]);
    expect(
      requests
        .slice(before)
        .some((request) => request.path.endsWith(`/messages/${MESSAGE.id}`)),
    ).toBe(false);
  });
});

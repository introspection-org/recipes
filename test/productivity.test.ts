import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadRecipeConnectors } from "../src/connector-tools.js";
import {
  BODY_LIMIT_CHARS,
  htmlToText,
  loadRecipeProductivity,
  PRODUCTIVITY_COMMAND_EFFECTS,
  PRODUCTIVITY_MODULE_API_VERSION,
  PRODUCTIVITY_SKILL,
  registerProductivityTools,
  type ProductivityCapabilities,
  type ProductivitySession,
} from "../src/productivity/index.js";
import { selectedAgentTools } from "../src/recipe/agent.js";
import { recipesVersion } from "../src/recipe/companions.js";
import {
  readPiPackageManifest,
  validatePiPackageManifest,
} from "../src/recipe/package.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

const PACKAGE = "@introspection-ai/recipe-productivity-fake";

const capabilities: ProductivityCapabilities = {
  mail: {
    labels: "categories",
    folders: "folders",
    commands: {
      search: { effect: "read", backend: "rest" },
      read: { effect: "read", backend: "rest" },
      fetch_attachment: { effect: "read", backend: "rest" },
      draft: { effect: "reversible", backend: "rest" },
      update_draft: { effect: "reversible", backend: "rest" },
      send: { effect: "irreversible", backend: "rest" },
      move: { effect: "reversible", backend: "rest" },
      label: {
        effect: "reversible",
        backend: "rest",
        note: "Outlook categories serve as labels.",
      },
    },
  },
  calendar: {
    commands: {
      list: { effect: "read", backend: "mcp" },
      read: { effect: "read", backend: "mcp" },
      create: { effect: "sends", backend: "rest" },
      respond: { effect: "sends", backend: "rest" },
    },
  },
  drive: {
    commands: {
      search: { effect: "read", backend: "rest" },
      read: { effect: "read", backend: "rest" },
      download: { effect: "read", backend: "rest" },
      upload: { effect: "reversible", backend: "rest" },
    },
  },
};

type Calls = Array<[string, unknown]>;

function providerError(code: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(`provider says ${code}`), {
    productivity: { code, message: `provider says ${code}`, ...extra },
  });
}

/** A fake provider session over one mailbox, calendar and drive. */
function fakeSession(calls: Calls): ProductivitySession {
  const record = (name: string, args: unknown) => calls.push([name, args]);
  return {
    provider: "fake",
    mail: {
      async search(args) {
        record("mail.search", args);
        if (args.query === "fail-auth")
          throw providerError("not_connected", { status: 401 });
        if (args.query === "fail-scope")
          throw providerError("missing_scope", {
            scope: "Mail.Read",
            status: 403,
          });
        if (args.query === "boom") throw new Error("socket hang up");
        if (args.query === "sparse") {
          // A provider that filters its pages: one item each, three pages.
          const n = Number(args.cursor ?? "0") + 1;
          return {
            messages: [{ id: `s-${n}`, subject: `#${n}` }],
            ...(n < 3 ? { cursor: String(n) } : {}),
          };
        }
        if (args.query === "many") {
          // A provider page it cannot cut: five items whatever the limit.
          const ids = args.cursor === "after-5" ? [6] : [1, 2, 3, 4, 5];
          return {
            messages: ids.map((n) => ({ id: `m-${n}`, subject: `#${n}` })),
            ...(args.cursor ? {} : { cursor: "after-5" }),
          };
        }
        return {
          messages: [
            {
              id: "AAMk-1",
              thread_id: "conv-1",
              subject: "Hello",
              from: { email: "a@example.com" },
            },
          ],
          ...(args.cursor ? {} : { cursor: "page-2" }),
        };
      },
      async read(args) {
        record("mail.read", args);
        if ("message_id" in args && args.message_id === "gone")
          throw providerError("not_found", { status: 404 });
        return {
          messages: [
            {
              id: "AAMk-1",
              thread_id: "conv-1",
              body: {
                content_type: "html",
                content: `<p>Hi <b>there</b></p><img src="https://track.example/p.gif"><p>${"x".repeat(BODY_LIMIT_CHARS + 50)}</p>`,
              },
              attachments: [{ id: "att-9", name: "../../report.pdf", size: 3 }],
            },
          ],
          ...("thread_id" in args
            ? { unavailable: "Only the latest 500 messages were read." }
            : {}),
        };
      },
      async fetchAttachment(args) {
        record("mail.fetchAttachment", args);
        return {
          name: "../../report.pdf",
          bytes: new TextEncoder().encode("pdf"),
        };
      },
      async draft(args) {
        record("mail.draft", args);
        return { id: "draft-1", thread_id: "conv-1", subject: args.subject };
      },
      async updateDraft(args) {
        record("mail.updateDraft", args);
        return { id: args.draft_id, subject: args.subject };
      },
      async send(args) {
        record("mail.send", args);
        return {};
      },
      async move(args) {
        record("mail.move", args);
        return { id: "AAMk-moved", folder: args.folder };
      },
      async label(args) {
        record("mail.label", args);
        return { id: args.message_id, labels: args.add ?? [] };
      },
    },
    calendar: {
      async list(args) {
        record("calendar.list", args);
        return {
          events: [
            {
              id: "evt-1",
              title: "Standup",
              start: "2026-03-02T09:00:00",
              end: "2026-03-02T09:15:00",
              time_zone: "Europe/London",
            },
          ],
        };
      },
      async read(args) {
        record("calendar.read", args);
        return {
          id: args.event_id,
          start: "2026-03-02T09:00:00",
          end: "2026-03-02T09:15:00",
          time_zone: "Europe/London",
        };
      },
      async create(args) {
        record("calendar.create", args);
        return {
          id: "evt-new",
          title: args.title,
          start: args.start,
          end: args.end,
          time_zone: args.time_zone,
        };
      },
      async respond(args) {
        record("calendar.respond", args);
      },
    },
    drive: {
      async search(args) {
        record("drive.search", args);
        return {
          files: [
            { id: "folder-1", name: "Contracts", is_folder: true },
            { id: "file-1", name: "MSA.docx" },
          ],
        };
      },
      async read(args) {
        record("drive.read", args);
        return {
          file: { id: args.file_id, name: "MSA.docx" },
          content: { content_type: "text", content: "terms" },
        };
      },
      async download(args) {
        record("drive.download", args);
        return { name: "MSA.docx", bytes: new TextEncoder().encode("docx") };
      },
      async upload(args) {
        record("drive.upload", args);
        return { id: "file-new", name: args.name };
      },
    },
  };
}

function setup(
  tools: Parameters<typeof registerProductivityTools>[1]["tools"] = {
    mail: [
      "search",
      "read",
      "fetch_attachment",
      "draft",
      "update_draft",
      "send",
      "move",
      "label",
    ],
    calendar: ["list", "read", "create", "respond"],
    drive: ["search", "read", "download", "upload"],
  },
) {
  const cwd = mkdtempSync(join(tmpdir(), "productivity-test-"));
  const calls: Calls = [];
  const pi = createMockExtensionAPI();
  registerProductivityTools(pi as never, {
    provider: "fake",
    capabilities,
    tools,
    cwd,
    downloadsDir: join(cwd, "files", "fake"),
    session: () => fakeSession(calls),
  });
  const run = async (tool: string, params: Record<string, unknown>) => {
    const result = (await pi.tools
      .get(tool)!
      .execute(
        "call",
        params as never,
        undefined,
        undefined,
        undefined as never,
      )) as {
      details: Record<string, any>;
      isError?: boolean;
    };
    return result;
  };
  return { pi, calls, cwd, run };
}

describe("productivity tools", () => {
  it("has a fixed effect for every command", () => {
    expect(PRODUCTIVITY_COMMAND_EFFECTS.mail.send).toBe("irreversible");
    expect(PRODUCTIVITY_COMMAND_EFFECTS.calendar.create).toBe("sends");
    expect(PRODUCTIVITY_COMMAND_EFFECTS.drive.search).toBe("read");
  });

  it("registers each tool with only its enabled commands in the schema", () => {
    const { pi } = setup({ mail: ["search", "read"], drive: ["search"] });
    expect([...pi.tools.keys()]).toEqual(["mail", "drive"]);
    const mail = pi.tools.get("mail")! as unknown as {
      parameters: {
        anyOf: Array<{ properties: { command: { const: string } } }>;
      };
      description: string;
    };
    expect(
      mail.parameters.anyOf.map((variant) => variant.properties.command.const),
    ).toEqual(["search", "read"]);
    expect(mail.description).not.toContain("\nsend ");
  });

  it("rejects a command outside the allowlist before any provider call", async () => {
    const { run, calls } = setup({ mail: ["search"] });
    const result = await run("mail", { command: "send", draft: "msg_x" });
    expect(result.isError).toBe(true);
    expect(result.details.error.code).toBe("invalid_request");
    expect(calls).toEqual([]);
  });

  it("states the provider's note and the effect in the description", () => {
    const { pi } = setup();
    const description = (
      pi.tools.get("mail") as unknown as { description: string }
    ).description;
    expect(description).toContain(
      "label { message, add?, remove? }: Add or remove categories on a message.",
    );
    expect(description).toContain("Outlook categories serve as labels.");
    expect(description).toMatch(/send \{ draft \}: .*Cannot be undone\./);
  });

  it("returns handles, never provider ids, and resolves them for the provider", async () => {
    const { run, calls } = setup();
    const search = await run("mail", { command: "search", query: "hello" });
    const [message] = search.details.messages;
    expect(message.message).toMatch(/^msg_/);
    expect(message.thread).toMatch(/^thr_/);
    expect(JSON.stringify(search.details)).not.toContain("AAMk-1");

    const thread = await run("mail", {
      command: "read",
      thread: message.thread,
    });
    expect(calls.at(-1)).toEqual(["mail.read", { thread_id: "conv-1" }]);
    expect(thread.details.unavailable).toBe(
      "Only the latest 500 messages were read.",
    );

    const again = await run("mail", { command: "search", query: "hello" });
    expect(again.details.messages[0].message).toBe(message.message);
  });

  it("refuses a fabricated handle, a provider id, and another session's handle", async () => {
    const first = setup();
    const other = setup();
    const theirs = (await other.run("mail", { command: "search", query: "x" }))
      .details.messages[0].message;
    for (const message of ["msg_0000000000000000", "AAMk-1", theirs]) {
      const result = await first.run("mail", { command: "read", message });
      expect(result.isError).toBe(true);
      expect(result.details.error.code).toBe("invalid_request");
    }
    expect(first.calls).toEqual([]);
  });

  it("scopes a cursor to the search that returned it", async () => {
    const { run, calls } = setup();
    const page = await run("mail", { command: "search", query: "a", limit: 1 });
    expect(page.details.cursor).toMatch(/^cur_/);
    const next = await run("mail", {
      command: "search",
      query: "a",
      cursor: page.details.cursor,
    });
    expect(next.isError).toBeUndefined();
    expect(calls.at(-1)?.[1]).toMatchObject({ cursor: "page-2", limit: 25 });
    const wrong = await run("mail", {
      command: "search",
      query: "b",
      cursor: page.details.cursor,
    });
    expect(wrong.details.error.message).toContain("another search");
  });

  it("keeps a provider's items past the limit for the next page", async () => {
    const { run, calls } = setup();
    const subjects: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await run("mail", {
        command: "search",
        query: "many",
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.details.messages.length).toBeLessThanOrEqual(2);
      subjects.push(
        ...page.details.messages.map((m: { subject: string }) => m.subject),
      );
      cursor = page.details.cursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(subjects).toEqual(["#1", "#2", "#3", "#4", "#5", "#6"]);
    // The overflow is served from the cursor, not fetched again.
    expect(calls.map(([, args]) => args)).toEqual([
      { query: "many", limit: 2 },
      { query: "many", limit: 1, cursor: "after-5" },
    ]);
  });

  it("fills a page from further calls when a provider filters its pages short", async () => {
    const { run, calls } = setup();
    const page = await run("mail", {
      command: "search",
      query: "sparse",
      limit: 3,
    });
    expect(
      page.details.messages.map((m: { subject: string }) => m.subject),
    ).toEqual(["#1", "#2", "#3"]);
    expect(page.details.cursor).toBeUndefined();
    expect(calls.map(([, args]) => args)).toEqual([
      { query: "sparse", limit: 3 },
      { query: "sparse", limit: 2, cursor: "1" },
      { query: "sparse", limit: 1, cursor: "2" },
    ]);
  });

  it("sends only a draft this session created, and only once", async () => {
    const { run, calls } = setup();
    const found = (await run("mail", { command: "search", query: "x" })).details
      .messages[0].message;
    const refused = await run("mail", { command: "send", draft: found });
    expect(refused.details.error.message).toContain(
      "not a draft created in this session",
    );
    expect(calls.some(([name]) => name === "mail.send")).toBe(false);

    const draft = (
      await run("mail", {
        command: "draft",
        to: ["b@example.com"],
        subject: "Re: Hello",
        body: "**Thanks**",
        reply_to: found,
      })
    ).details;
    expect(draft.draft).toMatch(/^msg_/);
    expect(calls.at(-1)).toEqual([
      "mail.draft",
      {
        to: ["b@example.com"],
        subject: "Re: Hello",
        body: "**Thanks**",
        reply_to_id: "AAMk-1",
      },
    ]);
    const updated = await run("mail", {
      command: "update_draft",
      draft: draft.draft,
      subject: "Re: Hi",
    });
    expect(updated.details.draft).toBe(draft.draft);

    const sent = await run("mail", { command: "send", draft: draft.draft });
    expect(sent.details.sent).toBe(true);
    expect(calls.at(-1)).toEqual(["mail.send", { draft_id: "draft-1" }]);
    const twice = await run("mail", { command: "send", draft: draft.draft });
    expect(twice.details.error.code).toBe("invalid_request");
  });

  it("keeps a moved message's handle", async () => {
    const { run, calls } = setup();
    const message = (await run("mail", { command: "search", query: "x" }))
      .details.messages[0].message;
    const moved = await run("mail", {
      command: "move",
      message,
      folder: "archive",
    });
    expect(moved.details.message).toBe(message);
    await run("mail", { command: "label", message, add: ["Red"] });
    expect(calls.at(-1)).toEqual([
      "mail.label",
      { message_id: "AAMk-moved", add: ["Red"], remove: [] },
    ]);
  });

  it("converts HTML bodies to text without remote content, capped at a stated limit", async () => {
    const { run } = setup();
    const message = (await run("mail", { command: "search", query: "x" }))
      .details.messages[0].message;
    const read = (await run("mail", { command: "read", message })).details
      .messages[0];
    expect(read.body.text.startsWith("Hi there\n\nxxx")).toBe(true);
    expect(read.body.text).not.toContain("track.example");
    expect(read.body).toMatchObject({
      truncated: true,
      limit_chars: BODY_LIMIT_CHARS,
    });
    expect(read.body.text.length).toBe(BODY_LIMIT_CHARS);
    expect(
      htmlToText(
        '<a href="https://x.test/a">docs</a> &amp; <script>evil()</script>',
      ),
    ).toBe("docs (https://x.test/a) &");
    expect(htmlToText("<p>&euro;5 &bull; &pound;4&middot;</p>")).toBe(
      "€5 • £4·",
    );
  });

  it("saves an attachment under the downloads folder, never outside it", async () => {
    const { run, cwd } = setup();
    const message = (await run("mail", { command: "search", query: "x" }))
      .details.messages[0].message;
    const attachment = (await run("mail", { command: "read", message })).details
      .messages[0].attachments[0];
    expect(attachment.attachment).toMatch(/^att_/);
    const saved = await run("mail", {
      command: "fetch_attachment",
      attachment: attachment.attachment,
    });
    expect(saved.details.path).toBe(
      join("files", "fake", attachment.attachment, "report.pdf"),
    );
    expect(readFileSync(join(cwd, saved.details.path), "utf8")).toBe("pdf");
  });

  it("maps provider errors to the shared shape", async () => {
    const { run } = setup();
    const notConnected = await run("mail", {
      command: "search",
      query: "fail-auth",
    });
    expect(notConnected.isError).toBe(true);
    expect(notConnected.details.error).toMatchObject({
      code: "not_connected",
      status: 401,
    });
    expect(notConnected.details.error.connect).toContain("connect");
    const scope = await run("mail", { command: "search", query: "fail-scope" });
    expect(scope.details.error).toMatchObject({
      code: "missing_scope",
      scope: "Mail.Read",
    });
    const other = await run("mail", { command: "search", query: "boom" });
    expect(other.details.error).toEqual({
      code: "provider_error",
      message: "socket hang up",
    });
  });

  it("drops a handle whose item is not found", async () => {
    const pi = createMockExtensionAPI();
    const calls: Calls = [];
    const session = fakeSession(calls);
    registerProductivityTools(pi as never, {
      provider: "fake",
      capabilities,
      tools: { mail: ["search", "read"] },
      cwd: tmpdir(),
      downloadsDir: tmpdir(),
      session: () => ({
        ...session,
        mail: {
          ...session.mail,
          search: async () => ({ messages: [{ id: "gone" }] }),
        },
      }),
    });
    const exec = (params: Record<string, unknown>) =>
      pi.tools
        .get("mail")!
        .execute(
          "c",
          params as never,
          undefined,
          undefined,
          undefined as never,
        ) as Promise<{
        details: Record<string, any>;
      }>;
    const message = (await exec({ command: "search", query: "x" })).details
      .messages[0].message;
    expect((await exec({ command: "read", message })).details.error.code).toBe(
      "not_found",
    );
    expect(
      (await exec({ command: "read", message })).details.error.message,
    ).toContain("Unknown message handle");
  });

  it("requires an explicit IANA time zone for calendar times", async () => {
    const { run, calls } = setup();
    const missing = await run("calendar", {
      command: "create",
      title: "Review",
      start: "2026-03-02T09:00:00",
      end: "2026-03-02T10:00:00",
      time_zone: "Mars/Olympus",
    });
    expect(missing.details.error.code).toBe("invalid_request");
    const created = await run("calendar", {
      command: "create",
      title: "Review",
      start: "2026-03-02T09:00:00",
      end: "2026-03-02T10:00:00",
      time_zone: "Europe/London",
      attendees: ["b@example.com"],
    });
    expect(created.details.event).toMatch(/^evt_/);
    const listed = await run("calendar", {
      command: "list",
      from: "2026-03-02",
      to: "2026-03-03T00:00:00Z",
    });
    expect(listed.details.error.message).toContain("RFC 3339");
    await run("calendar", {
      command: "respond",
      event: created.details.event,
      response: "accept",
    });
    expect(calls.at(-1)).toEqual([
      "calendar.respond",
      { event_id: "evt-new", response: "accept" },
    ]);
  });

  it("uploads only from outputs/, into a folder handle", async () => {
    const { run, calls, cwd } = setup();
    mkdirSync(join(cwd, "outputs"));
    writeFileSync(join(cwd, "outputs", "MSA-redline.docx"), "redline");
    writeFileSync(join(cwd, "secret.txt"), "no");
    const [folder, file] = (
      await run("drive", { command: "search", query: "MSA" })
    ).details.files;
    expect(folder.is_folder).toBe(true);

    const outside = await run("drive", {
      command: "upload",
      path: "secret.txt",
    });
    expect(outside.details.error.message).toContain("not under outputs/");
    const escape = await run("drive", {
      command: "upload",
      path: "outputs/../secret.txt",
    });
    expect(escape.details.error.code).toBe("invalid_request");
    const notFolder = await run("drive", {
      command: "upload",
      path: "outputs/MSA-redline.docx",
      folder: file.file,
    });
    expect(notFolder.details.error.message).toContain("not a folder");

    const uploaded = await run("drive", {
      command: "upload",
      path: "outputs/MSA-redline.docx",
      folder: folder.folder ?? folder.file,
    });
    expect(uploaded.details.file).toMatch(/^file_/);
    expect(calls.at(-1)).toEqual([
      "drive.upload",
      {
        name: "MSA-redline.docx",
        bytes: expect.any(Uint8Array),
        folder_id: "folder-1",
      },
    ]);

    const downloaded = await run("drive", {
      command: "download",
      file: file.file,
    });
    expect(existsSync(join(cwd, downloaded.details.path))).toBe(true);
  });

  it("refuses a session that does not implement an enabled command", async () => {
    const pi = createMockExtensionAPI();
    registerProductivityTools(pi as never, {
      provider: "fake",
      capabilities,
      tools: { calendar: ["list", "cancel"] },
      cwd: tmpdir(),
      downloadsDir: tmpdir(),
      session: () => fakeSession([]),
    });
    const result = (await pi.tools.get("calendar")!.execute(
      "c",
      {
        command: "list",
        from: "2026-03-02T00:00:00Z",
        to: "2026-03-03T00:00:00Z",
      } as never,
      undefined,
      undefined,
      undefined as never,
    )) as {
      details: Record<string, any>;
    };
    expect(result.details.error.message).toContain(
      "does not implement: calendar cancel",
    );
  });
});

/** A Recipe with a fake provider package in its node_modules. */
function recipe(
  productivity: unknown,
  options: { apiVersion?: number; capabilities?: unknown } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "productivity-recipe-"));
  const write = (path: string, body: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  };
  write(
    join(dir, "package.json"),
    JSON.stringify({
      name: "r",
      version: "0.1.0",
      type: "module",
      dependencies: { [PACKAGE]: "0.1.0" },
      pi: { productivity },
    }),
  );
  const packageDir = join(dir, "node_modules", ...PACKAGE.split("/"));
  write(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: PACKAGE,
      version: "0.1.0",
      type: "module",
      main: "index.js",
      peerDependencies: {
        "@introspection-ai/recipes": `>=${recipesVersion()}`,
      },
    }),
  );
  write(
    join(packageDir, "index.js"),
    `export default { kind: "productivity", apiVersion: ${options.apiVersion ?? PRODUCTIVITY_MODULE_API_VERSION}, provider: "fake",
      capabilities: ${JSON.stringify(options.capabilities ?? capabilities)},
      createSession: (options) => { globalThis.productivitySessionOptions = options; return { provider: "fake", mail: {}, calendar: {}, drive: {} }; } };\n`,
  );
  return dir;
}

describe("loading a productivity provider", () => {
  it("registers the selected tools and offers the core skill", async () => {
    const recipeDir = recipe([
      { provider: "fake", tools: { mail: ["search", "draft"] } },
    ]);
    const loaded = await loadRecipeConnectors(
      readPiPackageManifest(recipeDir),
      ["mail", "drive", "read"],
      {
        recipeDir,
      },
    );
    expect(loaded.loadout.toolNames).toEqual(["mail", "drive"]);
    expect(loaded.skillPaths).toEqual([PRODUCTIVITY_SKILL]);
    expect(existsSync(PRODUCTIVITY_SKILL)).toBe(true);
    expect(readFileSync(PRODUCTIVITY_SKILL, "utf8")).toMatch(
      /^---\nname: productivity\n/,
    );

    const pi = createMockExtensionAPI();
    await loaded.extensions[0]!.factory(pi as never);
    expect([...pi.tools.keys()]).toEqual(["mail", "drive"]);
    const discovered = await pi.handlers.get("resources_discover")![0]!({}, {});
    expect(discovered).toEqual({ skillPaths: [PRODUCTIVITY_SKILL] });
    const variants = (
      pi.tools.get("mail") as unknown as {
        parameters: {
          anyOf: Array<{ properties: { command: { const: string } } }>;
        };
      }
    ).parameters.anyOf.map((variant) => variant.properties.command.const);
    expect(variants).toEqual(["search", "draft"]);
  });

  it("offers nothing when the agent selects none of the tools", async () => {
    const recipeDir = recipe([{ provider: "fake" }]);
    const loaded = await loadRecipeProductivity(
      readPiPackageManifest(recipeDir).productivity!,
      ["read"],
      {
        recipeDir,
      },
    );
    expect(loaded).toEqual({ toolNames: [] });
  });

  it("refuses an unknown or unsupported command, and a tool the declaration disables", async () => {
    const load = (productivity: unknown, tools: string[] = ["mail"]) => {
      const recipeDir = recipe(productivity);
      return loadRecipeProductivity(
        readPiPackageManifest(recipeDir).productivity!,
        tools,
        { recipeDir },
      );
    };
    await expect(
      load([{ provider: "fake", tools: { mail: ["forward"] } }]),
    ).rejects.toThrow(
      "Unknown mail command in pi.productivity allowlist: forward",
    );
    await expect(
      load([{ provider: "fake", tools: { calendar: ["cancel"] } }]),
    ).rejects.toThrow(
      "Productivity provider 'fake' does not support calendar cancel",
    );
    await expect(
      load([{ provider: "fake", tools: { mail: [] } }]),
    ).rejects.toThrow(
      "The agent selects mail, which pi.productivity provider 'fake' does not enable",
    );
  });

  it('loads what include: ["*"] selects, leaving out a tool the declaration disables', async () => {
    const recipeDir = recipe([
      { provider: "fake", tools: { mail: [], calendar: ["list"] } },
    ]);
    const manifest = readPiPackageManifest(recipeDir);
    const { tools } = selectedAgentTools(["*"], undefined, manifest);
    const loaded = await loadRecipeProductivity(manifest.productivity!, tools, {
      recipeDir,
    });
    expect(loaded.toolNames).toEqual(["calendar"]);
  });

  it("refuses two providers", async () => {
    const recipeDir = recipe([{ provider: "fake" }, { provider: "other" }]);
    await expect(
      loadRecipeProductivity(
        readPiPackageManifest(recipeDir).productivity!,
        ["mail"],
        { recipeDir },
      ),
    ).rejects.toThrow(
      "A Recipe declares one productivity provider; pi.productivity names 'fake' and 'other'",
    );
    expect(
      validatePiPackageManifest(readPiPackageManifest(recipeDir)).findings.map(
        (finding) => finding.message,
      ),
    ).toContain(
      "package.json#pi.productivity declares more than one provider; a Recipe uses one productivity provider",
    );
  });

  it("refuses another contract version and a descriptor whose effect differs", async () => {
    const other = recipe([{ provider: "fake" }], { apiVersion: 2 });
    await expect(
      loadRecipeProductivity(
        readPiPackageManifest(other).productivity!,
        ["mail"],
        { recipeDir: other },
      ),
    ).rejects.toThrow("implements productivity module API 2");
    const wrong = recipe([{ provider: "fake" }], {
      capabilities: {
        mail: {
          labels: "labels",
          folders: "labels",
          commands: { send: { effect: "read", backend: "rest" } },
        },
      },
    });
    await expect(
      loadRecipeProductivity(
        readPiPackageManifest(wrong).productivity!,
        ["mail"],
        { recipeDir: wrong },
      ),
    ).rejects.toThrow("capabilities.mail.send must have effect 'irreversible'");
  });

  it("hands the provider the enabled commands, env and cwd", async () => {
    const recipeDir = recipe([
      { provider: "fake", tools: { mail: ["search"], drive: [] } },
    ]);
    const cwd = mkdtempSync(join(tmpdir(), "productivity-cwd-"));
    const loaded = await loadRecipeProductivity(
      readPiPackageManifest(recipeDir).productivity!,
      ["mail"],
      {
        recipeDir,
        cwd,
        env: { INTROSPECTION_TASK_ID: "t" },
      },
    );
    const pi = createMockExtensionAPI();
    await loaded.extension!.factory(pi as never);
    await pi.tools
      .get("mail")!
      .execute(
        "c",
        { command: "search", query: "x" } as never,
        undefined,
        undefined,
        undefined as never,
      );
    expect(
      (globalThis as { productivitySessionOptions?: unknown })
        .productivitySessionOptions,
    ).toMatchObject({
      config: {
        provider: "fake",
        tools: {
          mail: ["search"],
          calendar: ["list", "read", "create", "respond"],
        },
      },
      cwd,
      env: { INTROSPECTION_TASK_ID: "t" },
    });
  });

  it("validates the declaration's shape", () => {
    const findings = (productivity: unknown) =>
      validatePiPackageManifest(readPiPackageManifest(recipe(productivity)))
        .findings.filter(
          (finding) => finding.code === "pi.productivity_invalid",
        )
        .map((finding) => finding.message);
    expect(
      findings([{ provider: "fake", tools: { mail: ["search"] } }]),
    ).toEqual([]);
    expect(findings([{ provider: "fake", tools: { chat: ["read"] } }])).toEqual(
      [
        "package.json#pi.productivity[0].tools contains unknown tool 'chat'; use mail, calendar or drive",
      ],
    );
    expect(
      findings([{ provider: "fake", tools: { mail: ["forward"] } }]),
    ).toEqual([
      "package.json#pi.productivity[0].tools.mail contains unknown command 'forward'",
    ]);
    expect(findings({ provider: "fake" })).toEqual([
      "package.json#pi.productivity must be an array",
    ]);
    expect(resolve(PRODUCTIVITY_SKILL)).toBe(
      resolve("skills/productivity/SKILL.md"),
    );
  });
});

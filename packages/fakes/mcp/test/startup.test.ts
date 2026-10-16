import { describe, expect, test } from "vitest";
import { type Fake, type McpServer, startServices, text, toolConfig } from "../src/index.js";
import { world } from "./fixtures/fakes/scenarios/index.js";
import * as mail from "./fixtures/fakes/mcp/mail/index.js";
import type { Contract } from "./fixtures/fakes/mcp/notes/contract.js";
import manifest from "./fixtures/fakes/mcp/notes/manifest.json" with { type: "json" };
import tools from "./fixtures/fakes/mcp/notes/tools.json" with { type: "json" };

const config = toolConfig<Contract>(tools);

// Type-checks only while a manifest imported from JSON, whose icon theme the import widens to
// string, is a Fake's manifest without a cast.
const mailFake: Fake = mail;
const answer = async () => text("ok");

// The notes fake with its handlers replaced by `register`.
const notes = (
  register: (server: McpServer) => void,
  from: Fake["manifest"] = manifest,
): Record<string, Fake> => ({
  notes: { manifest: from, register },
});

const refused = (fakes: Record<string, Fake>) =>
  startServices(fakes, { world: (scenario) => world(scenario) }).then(
    async (services) => {
      await services.close();
      return "started";
    },
    (error: Error) => error.message,
  );

describe("the start-up check", () => {
  test("refuses handlers that miss a tool of the manifest's allow-list", async () => {
    expect(
      await refused(
        notes((server) => {
          server.registerTool("list-notes", config("list-notes"), answer);
          server.registerTool("create-note", config("create-note"), answer);
        }),
      ),
    ).toBe("The notes handlers do not register the tools its manifest allows: missing get-note");
  });

  test("refuses handlers that register a tool the manifest does not allow", async () => {
    expect(
      await refused(
        notes((server) => {
          server.registerTool("list-notes", config("list-notes"), answer);
          server.registerTool("search-everything", config("search-everything"), answer);
          server.registerTool("create-note", config("create-note"), answer);
          server.registerTool("get-note", config("get-note"), answer);
        }),
      ),
    ).toBe(
      "The notes handlers do not register the tools its manifest allows: not allowed search-everything",
    );
  });

  test("refuses a tool registered with a config not read from tools.json", async () => {
    expect(
      await refused(
        notes((server) => {
          server.registerTool("list-notes", { description: "Hand-written" }, answer);
          server.registerTool("create-note", config("get-note") as never, answer);
          server.registerTool("get-note", config("get-note"), answer);
        }),
      ),
    ).toBe(
      "The notes handlers do not register the tools its manifest allows: list-notes is not registered with config('list-notes'), create-note is not registered with config('create-note')",
    );
  });

  test("refuses tools registered out of the order tools.json gives", async () => {
    expect(
      await refused(
        notes((server) => {
          server.registerTool("create-note", config("create-note"), answer);
          server.registerTool("list-notes", config("list-notes"), answer);
          server.registerTool("get-note", config("get-note"), answer);
        }),
      ),
    ).toMatch(/registered as create-note, list-notes, get-note, not in the order of tools.json$/);
  });

  test("refuses a manifest whose server icon theme is neither light nor dark", async () => {
    const icons = [{ src: "https://notes.example.test/icon.svg", theme: "sepia" }];
    expect(await refused(notes(() => {}, { ...manifest, server: { ...manifest.server, icons } }))).toBe(
      "The notes manifest's server icon theme sepia is not light or dark",
    );
    expect(await refused({ mail: mailFake })).toBe("started");
  });

  test("refuses a fake the world holds no state for", async () => {
    const fake = notes(() => {}).notes;
    expect(await refused({ calendar: fake })).toBe("The world has no state for the fake calendar");
  });
});

describe("config", () => {
  test("refuses a tool that is not in tools.json", () => {
    expect(() => (config as (name: string) => unknown)("delete-note")).toThrow(
      "delete-note is not in tools.json",
    );
  });

  const declaring = (execution: object) =>
    toolConfig<{ run: { args: object } }>({
      tools: [{ name: "run", inputSchema: { type: "object" }, execution }],
    });

  test.each([
    { taskSupport: "forbidden" },
    {},
  ])("serves a captured tool declaring the default task support, %j", (execution) => {
    expect(declaring(execution)("run")).not.toHaveProperty("execution");
  });

  test.each(["optional", "required"])("refuses a captured tool whose task support is %s", (support) => {
    expect(() => declaring({ taskSupport: support })("run")).toThrow(
      `run declares execution {"taskSupport":"${support}"}, which the SDK cannot serve`,
    );
  });

  test("refuses a default below the top level, naming the tool and the path", () => {
    const nested = toolConfig<{ search: { args: object } }>({
      tools: [
        {
          name: "search",
          inputSchema: {
            type: "object",
            properties: {
              page: { type: "number", default: 1 },
              filter: {
                type: "object",
                properties: { op: { type: "string", default: "eq" } },
              },
              sorts: { type: "array", items: { anyOf: [{ type: "string", default: "name" }] } },
            },
          },
        },
      ],
    });
    expect(() => nested("search")).toThrow(
      "search states a default below the top level of its input schema, which the host does not fill: /properties/filter/properties/op, /properties/sorts/items/anyOf/0",
    );
  });

  test("carries the captured title, annotations and _meta", () => {
    const created = config("create-note");
    expect(created.title).toBe("Create a note");
    expect(created.annotations).toEqual({ readOnlyHint: false });
    expect(created._meta).toEqual({ "example.test/captured": true });
  });
});

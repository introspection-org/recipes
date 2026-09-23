import { describe, expect, it } from "vitest";
import {
  compactSchemaType,
  renderToolContract,
  renderToolSignature,
} from "../src/mcp/contract.js";

describe("compact MCP contracts", () => {
  const inputSchema = {
    type: "object",
    properties: {
      q: { type: "string" },
      limit: { type: "integer", minimum: 0, maximum: 250 },
      group: {
        anyOf: [
          { const: "off" },
          {
            type: "object",
            properties: {
              field: { type: "string", minLength: 1 },
              limit: { type: "integer", minimum: 1, maximum: 250 },
            },
            required: ["field"],
          },
        ],
      },
    },
    required: ["q"],
  };

  it("renders unions and constraints without JSON Schema ceremony", () => {
    expect(compactSchemaType(inputSchema.properties.group)).toBe(
      '"off" | {field: string [minLength=1], limit?: integer [1..250]}'
    );
    const outputSchema = {
      type: "object",
      properties: { found: { type: "integer", minimum: 0 } },
      required: ["found"],
    };
    const contract = renderToolContract("nextplay", {
        name: "search_profiles",
        description: "Search profiles.",
        inputSchema,
        outputSchema,
      });
    expect(contract).toBe(
      [
        "nextplay.search_profiles",
        "Search profiles.",
        "",
        "input",
        "  q: string",
        "  limit?: integer [0..250]",
        '  group?: "off" | {field: string [minLength=1], limit?: integer [1..250]}',
        "",
        "output",
        "  found: integer [0..]",
        "",
        "call",
        "  mcp call nextplay.search_profiles q='<q>'",
        `  structured: mcp call nextplay.search_profiles --json '{"q":"<q>","group":{"field":"<field>"}}'`,
        "",
      ].join("\n")
    );
    expect(contract.length).toBeLessThan(
      JSON.stringify(inputSchema, null, 2).length + JSON.stringify(outputSchema, null, 2).length
    );
  });

  it("keeps signatures short by default", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`field${index}`, { type: "string" }])
    );
    expect(
      renderToolSignature("nextplay", {
        name: "search",
        inputSchema: { type: "object", properties },
      })
    ).toContain("… +3 optional");
    expect(
      renderToolSignature(
        "nextplay",
        { name: "search", inputSchema: { type: "object", properties } },
        { allParameters: true }
      )
    ).not.toContain("...");
  });

  it("always keeps required parameters visible regardless of property order", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`field${index}`, { type: "string" }])
    );
    const signature = renderToolSignature("nextplay", {
      name: "ordered",
      inputSchema: {
        type: "object",
        properties,
        required: ["field7"],
      },
    });
    expect(signature).toContain("field7: string");
    expect(signature).toContain("… +3 optional");
  });

  it("keeps constrained required call examples type-correct", () => {
    const contract = renderToolContract("server", {
      name: "constrained",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 0, maximum: 10 },
          tags: {
            type: "array",
            minItems: 2,
            items: { type: "string", minLength: 1 },
          },
        },
        required: ["limit", "tags"],
      },
    });
    expect(contract).toContain(
      `mcp call server.constrained --json '{"limit":0,"tags":["<value>","<value>"]}'`
    );
  });

  it("caps generated array examples while preserving minItems in the contract", () => {
    const contract = renderToolContract("server", {
      name: "bulk",
      inputSchema: {
        type: "object",
        properties: {
          items: { type: "array", minItems: 10_000, items: { type: "string" } },
        },
        required: ["items"],
      },
    });
    expect(contract).toContain("items: string[] [minItems=10000]");
    expect(contract).toContain(
      `mcp call server.bulk --json '{"items":["<value>","<value>","<value>"]}'`
    );
    expect(contract.length).toBeLessThan(1_000);
  });

  it("uses populated JSON for required structured inputs", () => {
    const contract = renderToolContract("server", {
      name: "structured",
      inputSchema: {
        type: "object",
        properties: {
          request: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
        required: ["request"],
      },
    });
    expect(contract).toContain(
      `mcp call server.structured --json '{"request":{"query":"<query>"}}'`
    );
  });

  it("merges object allOf branches", () => {
    const contract = renderToolContract("server", {
      name: "composed",
      inputSchema: {
        allOf: [
          {
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"],
          },
          {
            type: "object",
            properties: { limit: { type: "integer", minimum: 1 } },
          },
        ],
      },
    });
    expect(contract).toContain("  q: string");
    expect(contract).toContain("  limit?: integer [1..]");
    expect(contract).toContain("mcp call server.composed q='<q>'");
    expect(
      renderToolSignature("server", {
        name: "composed",
        inputSchema: {
          allOf: [
            {
              type: "object",
              properties: { q: { type: "string" } },
              required: ["q"],
            },
            {
              type: "object",
              properties: { limit: { type: "integer", minimum: 1 } },
            },
          ],
        },
      })
    ).toBe("server.composed(q: string, limit?: integer [1..])");
  });

  it("shell-quotes schema-provided call values", () => {
    const contract = renderToolContract("server", {
      name: "unsafe",
      inputSchema: {
        type: "object",
        properties: {
          mode: { enum: ["$TOKEN $(touch /tmp/nope) it's"] },
        },
        required: ["mode"],
      },
    });
    expect(contract).toContain(`mode='$TOKEN $(touch /tmp/nope) it'"'"'s'`);
    expect(contract).not.toContain(`mode="$TOKEN`);
  });

  it("uses JSON for unsafe parameter names and quotes unsafe selectors", () => {
    const contract = renderToolContract("unsafe server", {
      name: "lookup; touch /tmp/nope",
      inputSchema: {
        type: "object",
        properties: { "q; touch /tmp/nope": { type: "string" } },
        required: ["q; touch /tmp/nope"],
      },
    });
    expect(contract).toContain(
      `mcp call 'unsafe server.lookup; touch /tmp/nope' --json '{"q; touch /tmp/nope":"<q; touch /tmp/nope>"}'`
    );
    expect(contract).not.toContain("mcp call unsafe server.lookup; touch");
    expect(contract).not.toContain(" q; touch /tmp/nope=");
  });

  it("compacts descriptions by default and preserves them in verbose contracts", () => {
    const description = `Important field. ${"detail ".repeat(40)}`;
    const tool = {
      name: "described",
      description,
      inputSchema: {
        type: "object",
        properties: { q: { type: "string", description } },
      },
    };
    const compact = renderToolContract("server", tool);
    const verbose = renderToolContract("server", tool, { verboseDescriptions: true });
    expect(compact).toContain("…");
    expect(compact).toContain("Descriptions shortened; use --verbose for full text.");
    expect(compact.length).toBeLessThan(verbose.length);
    expect(verbose).not.toContain("Descriptions shortened");
    expect(verbose).toContain(description.trim().replace(/\s+/g, " "));
  });
});

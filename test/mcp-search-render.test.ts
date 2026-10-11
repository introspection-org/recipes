import { describe, expect, it } from "vitest";

import { renderSearchResults } from "../src/mcp/cli/core.js";

const tool = (name: string, fields: number) => ({
  name,
  description: `Tool ${name}`,
  input_schema: {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: fields }, (_, i) => [`field_${i}`, { type: "string", description: "x".repeat(80) }])
    ),
  },
});
const match = (name: string) => ({
  ref: `mail.${name}`,
  server: "mail",
  tool: name,
  description: `Tool ${name}`,
  required: [],
  score: 1,
  inspect: "",
  call: "",
});

describe("search results", () => {
  it("show every contract while they fit", () => {
    const out = renderSearchResults(
      [match("a"), match("b")],
      new Map([["mail", [tool("a", 2), tool("b", 2)]]])
    );
    expect(out.match(/\ninput\n/g)).toHaveLength(2);
    expect(out).not.toContain("The rest are signatures");
  });

  it("keep the best contract and cut the rest to signatures past the budget", () => {
    const names = ["a", "b", "c", "d", "e"];
    const out = renderSearchResults(
      names.map(match),
      new Map([["mail", names.map((name) => tool(name, 30))]])
    );
    expect(out.startsWith("mail.a\n")).toBe(true);
    expect(out).toContain("\nmail.e(");
    expect(out).toContain("The rest are signatures");
    expect(out.length).toBeLessThan(9_000);
  });
});

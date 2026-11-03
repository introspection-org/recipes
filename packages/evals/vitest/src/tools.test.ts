import { piToolNames } from "@introspection-ai/recipe-fakes-mcp/verify";
import { describe, expect, it } from "vitest";

import { piToolCalls, serverCalls } from "./index.js";

const root = { id: "root" };
const start = (toolCallId: string, toolName: string, args: unknown, run = root) => ({
  type: "tool_execution_start",
  toolCallId,
  toolName,
  args,
  run,
});
const end = (toolCallId: string, result: unknown, isError = false, run = root) => ({
  type: "tool_execution_end",
  toolCallId,
  result,
  isError,
  run,
});
const text = (value: string) => ({ content: [{ type: "text", text: value }] });

describe("piToolCalls", () => {
  it("pairs each started call with its end, in start order", () => {
    const piEvents = [
      { type: "message_end", message: {} },
      start("a", "bash", { command: "date -u" }),
      start("b", "mcp_crm_list-records", { object: "deals" }),
      end("b", {
        content: [{ type: "text", text: "{\"rows\":[]}" }],
        details: { structuredContent: { rows: [] } },
      }),
      end("a", text("boom"), true),
    ];

    expect(piToolCalls(piEvents)).toEqual([
      {
        name: "bash",
        args: { command: "date -u" },
        isError: true,
        content: [{ type: "text", text: "boom" }],
      },
      {
        name: "mcp_crm_list-records",
        args: { object: "deals" },
        isError: false,
        content: [{ type: "text", text: "{\"rows\":[]}" }],
        structured: { rows: [] },
      },
    ]);
  });

  it("keeps structuredContent only when it is an object", () => {
    const piEvents = [
      start("a", "read", {}),
      end("a", { content: [], details: { structuredContent: ["not", "an", "object"] } }),
    ];

    expect(piToolCalls(piEvents)[0]).not.toHaveProperty("structured");
  });

  it("leaves out a call that never ended and keys calls by their run", () => {
    const subagent = { id: "sub" };
    const piEvents = [
      start("1", "read", { path: "a" }),
      start("1", "read", { path: "b" }, subagent),
      end("1", text("from b"), false, subagent),
      start("2", "bash", {}),
    ];

    expect(piToolCalls(piEvents)).toEqual([
      { name: "read", args: { path: "b" }, isError: false, content: text("from b").content },
    ]);
  });

  it("reads nothing from a missing artifact", () => {
    expect(piToolCalls(undefined)).toEqual([]);
  });
});

describe("serverCalls", () => {
  it("lists one server's calls under its own tool names", () => {
    const calls = piToolCalls([
      start("a", "mcp_crm_list-records", { object: "deals" }),
      end("a", {
        content: [
          { type: "text", text: "rows[1]: " },
          { type: "image", data: "" },
          { type: "text", text: "acme" },
        ],
      }),
      start("b", "mcp_crm_update-record_0123456789", { id: "x" }),
      end("b", { ...text("{}"), details: { structuredContent: { id: "x" } } }),
      start("c", "mcp_crmx_list-records", {}),
      end("c", text("other server")),
      start("d", "mcp_mail_send-email", {}),
      end("d", text("denied"), true),
    ]);

    expect(serverCalls(calls, "crm")).toEqual([
      { name: "list-records", args: { object: "deals" }, isError: false, response: "rows[1]: acme" },
      {
        name: "update-record",
        args: { id: "x" },
        isError: false,
        response: "{}",
        structured: { id: "x" },
      },
    ]);
    expect(serverCalls(calls, "mail")).toEqual([
      { name: "send-email", args: {}, isError: true, response: "denied" },
    ]);
  });

  it("names a cut-short, hashed call by the server's tool it hashes", () => {
    const tool = "crm.get-customer-record-with-all-associated-contact-details";
    const [hashed] = piToolNames("crm", tool);
    const calls = piToolCalls([
      start("a", hashed, { id: "x" }),
      end("a", text("{}")),
      start("b", "mcp_crm_list-records", {}),
      end("b", text("[]")),
      start("c", "mcp_crm_unlisted", {}),
      end("c", text("")),
    ]);

    expect(serverCalls(calls, "crm", [tool, "list-records"])).toEqual([
      { name: tool, args: { id: "x" }, isError: false, response: "{}" },
      { name: "list-records", args: {}, isError: false, response: "[]" },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import {
  conversationSynthesis,
  middleCut,
  parsePreprocess,
  promptBuilder,
  PromptError,
  trajectoryLlmClassify,
  trajectoryLlmJudge,
} from "../src/prompts/index.js";
import { renderTemplate, TemplateError } from "../src/prompts/template.js";

describe("a prompt template", () => {
  it("fills placeholders, with or without spaces", () => {
    expect(renderTemplate("a {{x}} b {{ y }}", { x: "1", y: "2" })).toBe(
      "a 1 b 2",
    );
  });

  it("refuses a placeholder no slot fills", () => {
    expect(() => renderTemplate("{{ missing }}", {})).toThrow(TemplateError);
  });

  it("drops a block whose placeholders all render empty, heading included", () => {
    expect(
      renderTemplate("HEAD\n{{ a }}\n\nOPTIONAL\n{{ b }}\n\nTAIL", {
        a: "1",
        b: "",
      }),
    ).toBe("HEAD\n1\n\nTAIL");
  });

  it("keeps a block with one placeholder filled and leaves slot text alone", () => {
    expect(
      renderTemplate("{{ a }} {{ b }}", { a: "", b: "{{ c }}\n\nx" }),
    ).toBe(" {{ c }}\n\nx");
  });
});

describe("fitting a prompt", () => {
  it("cuts the middle without splitting a surrogate pair", () => {
    const cut = middleCut("🙂".repeat(100), 81);
    expect(cut.length).toBeLessThanOrEqual(81);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("cuts a built prompt over its budget and says so", () => {
    const input = {
      schema_version: 2,
      trajectory: [
        {
          type: "message" as const,
          role: "user" as const,
          content: "x".repeat(500),
        },
      ],
    };
    const built = trajectoryLlmJudge.build(input, 66);
    expect(built.applied).toEqual(["middle_cut"]);
    expect(built.prompt.length).toBeLessThanOrEqual(66 * 3);
    expect(trajectoryLlmJudge.build(input, 10_000).applied).toEqual([]);
  });

  it("passes a builder its options", () => {
    const input = {
      schema_version: 2,
      trajectory: [
        { type: "tool_call" as const, id: "c", name: "run", arguments: {} },
        {
          type: "tool_result" as const,
          tool_call_id: "c",
          content: "y".repeat(1_000),
        },
      ],
    };
    const wide = trajectoryLlmClassify.build(input, 10_000, {
      head: 300,
      tail: 10,
    });
    expect(wide.prompt).toContain(`${"y".repeat(300)} […] ${"y".repeat(10)}`);
  });
});

describe("the builder registry", () => {
  it("finds a builder by name and version, and refuses one it does not hold", () => {
    expect(promptBuilder("conversation_synthesis@1")).toBe(
      conversationSynthesis,
    );
    expect(promptBuilder("trajectory_llm_judge@1")).toBe(trajectoryLlmJudge);
    expect(promptBuilder("trajectory_llm_classify@1")).toBe(
      trajectoryLlmClassify,
    );
    expect(() => promptBuilder("conversation_synthesis@2")).toThrow(
      PromptError,
    );
  });

  it("reads an input as a bare name or a builder with options", () => {
    expect(parsePreprocess("conversation_synthesis@1")).toEqual({
      builder: "conversation_synthesis@1",
    });
    expect(
      parsePreprocess({
        builder: "trajectory_llm_classify@1",
        options: { head: 200 },
      }),
    ).toEqual({
      builder: "trajectory_llm_classify@1",
      options: { head: 200 },
    });
    expect(() => parsePreprocess("nope@1")).toThrow(PromptError);
  });
});

describe("conversation_synthesis@1 resuming", () => {
  const call = (span: string, text: string) => ({
    span_id: span,
    timestamp: "2026-11-12T09:00:00Z",
    timestamp_ns: "1794474000000000000",
    input_message_count: 1,
    input_new_messages: [
      { role: "user", parts: [{ type: "text", content: text }] },
    ],
    output_messages: [],
  });
  const cursor = (span: string) =>
    Buffer.from(
      JSON.stringify({
        i: span,
        s: "created_at",
        d: "asc",
        v: "1794474000000000000",
      }),
    ).toString("base64url");

  it("reads a call at the cursor's instant with a later span, and not the cursor's own call", () => {
    const built = conversationSynthesis.build(
      {
        conversation_id: "c",
        completed_at: "2026-11-12T09:00:00Z",
        model_calls: [
          call("span-a", "already read"),
          call("span-b", "new at the same instant"),
        ],
        watermark: {
          watermark: "2026-11-12T09:00:00Z",
          cursor: cursor("span-a"),
          segment: 1,
        },
      },
      300_000,
    );
    expect(built.prompt).toContain("new at the same instant");
    expect(built.prompt).not.toContain("already read");
  });
});

describe("conversation_synthesis@1 timestamps", () => {
  it("keeps sub-millisecond precision from an ISO timestamp, for the cursor and for resuming", () => {
    const call = (span: string, timestamp: string, text: string) => ({
      span_id: span,
      timestamp,
      input_message_count: 1,
      input_new_messages: [
        { role: "user", parts: [{ type: "text", content: text }] },
      ],
      output_messages: [],
    });
    const first = conversationSynthesis.build(
      {
        conversation_id: "c",
        completed_at: "2026-11-19T00:00:00Z",
        model_calls: [call("s1", "2026-11-19T00:00:00.123400Z", "earlier")],
      },
      300_000,
    );
    const plan = (
      first.state as unknown as { plan: { watermark_next: { cursor: string } } }
    ).plan;
    const cursor = JSON.parse(
      Buffer.from(plan.watermark_next.cursor, "base64url").toString(),
    );
    expect(cursor.v).toBe("1795046400123400000");

    const resumed = conversationSynthesis.build(
      {
        conversation_id: "c",
        completed_at: "2026-11-19T00:00:00Z",
        model_calls: [
          call("s1", "2026-11-19T00:00:00.123400Z", "earlier"),
          call("s2", "2026-11-19T00:00:00.123456Z", "a little later"),
        ],
        watermark: {
          watermark: "2026-11-19T00:00:00.123400Z",
          cursor: plan.watermark_next.cursor,
          segment: 1,
        },
      },
      300_000,
    );
    expect(resumed.prompt).toContain("a little later");
    expect(resumed.prompt).not.toContain("earlier");
  });
});

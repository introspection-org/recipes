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

import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  conversationCaseBuilder,
  FitError,
  stepName,
  middleCut,
  promptBuilder,
  validatePromptSpec,
  type PromptBuilder,
  renderTemplate,
  TemplateError,
  trajectoryBuilder,
} from "../src/prompts/index.js";

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

  it("refuses a step the builder does not have", () => {
    const input = { schema_version: 2, trajectory: [] };
    expect(() =>
      buildPrompt(trajectoryBuilder, input, {
        budget: { maxUnits: 100 },
        steps: ["head_tail"],
      }),
    ).toThrow(FitError);
  });

  it("reports the steps it applied and names the builder", () => {
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
    const built = buildPrompt(trajectoryBuilder, input, {
      budget: { maxUnits: 200 },
      steps: ["clip_tool_values"],
    });
    expect(built.builder).toBe("trajectory@1");
    expect(built.applied).toEqual(["clip_tool_values", "middle_cut"]);
    expect(built.prompt.length).toBeLessThanOrEqual(200);
  });

  it("runs the spec's steps with the builder's options, and cuts the middle only when over budget", () => {
    const builder: PromptBuilder<string, undefined, { label: string }> = {
      name: "stub",
      version: 1,
      defaultTemplate: "{{ text }}",
      defaultSteps: [],
      supportedSteps: new Set(["half"]),
      build(input, steps, options) {
        const names = steps.map((step) => stepName(step)[0]);
        const text = names.includes("half")
          ? input.slice(0, input.length / 2)
          : input;
        return { slots: { text: `${options?.label}:${text}` }, applied: names };
      },
    };
    const fits = buildPrompt(builder, "x".repeat(100), {
      budget: { maxUnits: 60 },
      steps: ["half"],
      options: { label: "case" },
    });
    expect(fits.applied).toEqual(["half"]);
    expect(fits.prompt).toBe(`case:${"x".repeat(50)}`);

    const over = buildPrompt(builder, "x".repeat(100), {
      budget: { maxUnits: 90 },
      options: { label: "case" },
    });
    expect(over.applied).toEqual(["middle_cut"]);
    expect(over.prompt.length).toBeLessThanOrEqual(90);
  });
});

describe("the builder registry", () => {
  it("finds a builder by name and version, and refuses one it does not hold", () => {
    expect(promptBuilder("conversation_case@1")).toBe(conversationCaseBuilder);
    expect(promptBuilder("trajectory@1")).toBe(trajectoryBuilder);
    expect(() => promptBuilder("conversation_case@2")).toThrow(FitError);
  });
});

describe("an input spec", () => {
  it("accepts the steps its builder runs and refuses anything else, naming each problem", () => {
    const spec = {
      builder: "conversation_case@1",
      steps: ["truncate_messages", { head_tail: { head: 800, tail: 300 } }],
      template: "{{ conversation_case }}",
    };
    expect(validatePromptSpec(spec)).toEqual(spec);
    expect(() =>
      validatePromptSpec({
        builder: "conversation_case@1",
        steps: ["slim_tool_results"],
        budget: 1,
      }),
    ).toThrow(
      /unknown key\(s\) budget; conversation_case@1 has no step "slim_tool_results"/,
    );
    expect(() =>
      validatePromptSpec({ builder: "conversation_case@9" }),
    ).toThrow(FitError);
  });
});

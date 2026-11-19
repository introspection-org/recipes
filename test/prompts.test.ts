import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  FitError,
  middleCut,
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
        fit: { always: ["head_tail"] },
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
      fit: { always: ["clip_tool_values"], last_resort: "middle_cut" },
    });
    expect(built.builder).toBe("trajectory@1");
    expect(built.applied).toEqual(["clip_tool_values", "middle_cut"]);
    expect(built.prompt.length).toBeLessThanOrEqual(200);
  });
});

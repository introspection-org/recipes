import { describe, expect, it } from "vitest";

import {
  latestRecipeSession,
  recipeSessionChanged,
} from "../src/recipe-session-entry.js";

const entry = (data: object) => ({
  type: "custom",
  customType: "recipe_session",
  data,
});
const recorded = {
  recipe_dir: "/r/interviewer",
  agent: "agent",
  package: "interviewer",
  version: "0.1.0",
};

describe("the Recipe a session records", () => {
  it("is the latest recipe_session entry", () => {
    const entries = [
      entry({ ...recorded, agent: "old" }),
      { type: "message" },
      entry(recorded),
    ];
    expect(latestRecipeSession(entries)).toEqual(recorded);
    expect(latestRecipeSession([{ type: "message" }])).toBeUndefined();
  });

  it("is recorded again only when the Recipe, agent or version changes", () => {
    expect(recipeSessionChanged([], recorded)).toBe(true);
    expect(recipeSessionChanged([entry(recorded)], recorded)).toBe(false);
    expect(
      recipeSessionChanged([entry(recorded)], {
        ...recorded,
        agent: "reviewer",
      }),
    ).toBe(true);
  });
});

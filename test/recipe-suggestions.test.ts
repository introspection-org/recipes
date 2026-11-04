/**
 * A Recipe's prompt templates marked `suggest: true` are its suggestions: the read API other
 * surfaces use, the placeholder filling, and the first-run picker Pi shows in
 * a new terminal session.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ASK_USER_TYPED_ANSWER_OPTION } from "../src/ask-user-question.js";
import { inspectRecipe } from "../src/inspect.js";
import { createRecipesExtension } from "../src/pi-extension.js";
import { resolveRecipe } from "../src/recipe/resolve.js";
import {
  expandWithoutArguments,
  fillSuggestion,
  findPlaceholders,
  listRecipeSuggestions,
  pickSuggestions,
  seededRandom,
} from "../src/recipe/suggestions.js";
import {
  SUGGESTIONS_QUESTION,
  SUGGESTIONS_SEED_ENV,
} from "../src/suggestion-picker.js";
import { writeFixtureRecipe } from "../src/test-utils.js";
import { createMockExtensionAPI } from "./helpers/mock-extension.js";

const TEMPLATES: Record<string, string> = {
  "redline.md": [
    "---",
    "suggest: true",
    "description: Redline a contract against the playbook",
    "---",
    "Redline ${1:-the attached contract} for {{member.name}} on {{today}}.",
  ].join("\n"),
  "respond.md": [
    "---",
    "suggest: true",
    "description: Draft a reply to the other side",
    'argument-hint: "[tone]"',
    "---",
    "Draft a reply in a ${1:-neutral} tone.",
  ].join("\n"),
  "risks.md": "---\nsuggest: true\n---\nList the top risks in $@.\n",
  "summarize.md": [
    "---",
    "suggest: true",
    "description: Summarize a file",
    'argument-hint: "<file>"',
    "---",
    "Summarize $1 for {{org.name}}.",
  ].join("\n"),
  // Not suggestions: unmarked, off, or not a boolean. They still work as /name.
  "notes.md": "---\ndescription: Take notes\n---\nTake notes.",
  "off.md": "---\nsuggest: false\ndescription: Off\n---\nOff.",
  "string.md": '---\nsuggest: "true"\ndescription: String\n---\nString.',
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

function recipeWithPrompts(templates: Record<string, string> = TEMPLATES) {
  const fixture = writeFixtureRecipe({ manifestPi: { prompts: ["./prompts/*.md"] } });
  cleanups.push(fixture.cleanup);
  mkdirSync(join(fixture.recipeDir, "prompts"));
  for (const [name, content] of Object.entries(templates)) {
    writeFileSync(join(fixture.recipeDir, "prompts", name), content);
  }
  return fixture;
}

describe("listRecipeSuggestions", () => {
  it("reads each marked template's name, description, hint, text and placeholders", () => {
    const { recipeDir } = recipeWithPrompts();
    expect(listRecipeSuggestions(recipeDir)).toEqual([
      {
        name: "redline",
        description: "Redline a contract against the playbook",
        text: "Redline ${1:-the attached contract} for {{member.name}} on {{today}}.",
        placeholders: ["member.name", "today"],
      },
      {
        name: "respond",
        description: "Draft a reply to the other side",
        argumentHint: "[tone]",
        text: "Draft a reply in a ${1:-neutral} tone.",
        placeholders: [],
      },
      {
        // No description: Pi falls back to the first non-empty line.
        name: "risks",
        description: "List the top risks in $@.",
        text: "List the top risks in $@.",
        placeholders: [],
      },
      {
        name: "summarize",
        description: "Summarize a file",
        argumentHint: "<file>",
        text: "Summarize $1 for {{org.name}}.",
        placeholders: ["org.name"],
      },
    ]);
  });

  it("reads the conventional prompts directory and returns [] with none marked", () => {
    const fixture = writeFixtureRecipe();
    cleanups.push(fixture.cleanup);
    expect(listRecipeSuggestions(fixture.recipeDir)).toEqual([]);
    mkdirSync(join(fixture.recipeDir, "prompts"));
    writeFileSync(
      join(fixture.recipeDir, "prompts", "plan.md"),
      "---\ndescription: Plan the week\n---\nPlan it."
    );
    expect(listRecipeSuggestions(fixture.recipeDir)).toEqual([]);
    writeFileSync(
      join(fixture.recipeDir, "prompts", "plan.md"),
      "---\nsuggest: true\ndescription: Plan the week\n---\nPlan it."
    );
    expect(listRecipeSuggestions(fixture.recipeDir).map((s) => s.name)).toEqual(["plan"]);
  });

  it("lets the first template with a name win, marked or not, as Pi does", () => {
    const fixture = writeFixtureRecipe({
      manifestPi: { prompts: ["./first", "./second"] },
    });
    cleanups.push(fixture.cleanup);
    for (const [dir, content] of [
      ["first", "---\ndescription: First\n---\nFirst."],
      ["second", "---\nsuggest: true\ndescription: Second\n---\nSecond."],
    ] as const) {
      mkdirSync(join(fixture.recipeDir, dir));
      writeFileSync(join(fixture.recipeDir, dir, "plan.md"), content);
    }
    expect(listRecipeSuggestions(fixture.recipeDir)).toEqual([]);
  });

  it("is part of inspectRecipe", () => {
    const { recipeDir } = recipeWithPrompts();
    const inspection = inspectRecipe(resolveRecipe({ recipeDir }));
    expect(inspection.suggestions.map((s) => s.name)).toEqual([
      "redline",
      "respond",
      "risks",
      "summarize",
    ]);
  });
});

describe("placeholders", () => {
  it("fills allowlisted placeholders that have a value and leaves the rest", () => {
    const text =
      "{{member.name}} <{{member.email}}> at {{org.name}} on {{today}}; {{deal.id}} {{ today }}";
    expect(
      fillSuggestion(text, { "member.name": "Ada", today: "2026-11-03", "org.name": "" })
    ).toBe("Ada <{{member.email}}> at {{org.name}} on 2026-11-03; {{deal.id}} {{ today }}");
    expect(
      fillSuggestion("{{deal.id}}", { "deal.id": "x" } as Record<string, string>)
    ).toBe("{{deal.id}}");
    expect(findPlaceholders(text)).toEqual([
      "member.name",
      "member.email",
      "org.name",
      "today",
      "deal.id",
    ]);
  });

  it("expands Pi arguments with none given, keeping defaults", () => {
    expect(expandWithoutArguments("a ${1:-x} b $1 c ${@:-all} d $@ e ${@:2} f $ARGUMENTS")).toBe(
      "a x b  c all d  e  f "
    );
  });
});

describe("pickSuggestions", () => {
  it("keeps three or fewer as they are", () => {
    expect(pickSuggestions([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("picks a random three in their original order that a seed pins", () => {
    const items = ["a", "b", "c", "d", "e", "f"];
    const first = pickSuggestions(items, 3, seededRandom("eval-1"));
    expect(first).toHaveLength(3);
    expect(new Set(first).size).toBe(3);
    expect(pickSuggestions(items, 3, seededRandom("eval-1"))).toEqual(first);
    expect([...first].sort()).toEqual(first);
    const seen = new Set(
      ["1", "2", "3", "4", "5", "6", "7", "8"].map((seed) =>
        pickSuggestions(items, 3, seededRandom(seed)).join()
      )
    );
    expect(seen.size).toBeGreaterThan(1);
  });
});

interface PickerOptions {
  mode?: string;
  reason?: string;
  entries?: Array<{ type: string }>;
  select?: (title: string, options: string[], dialog?: { signal?: AbortSignal }) => Promise<string | undefined>;
  input?: string;
  templates?: Record<string, string>;
  seed?: string;
  gitName?: string;
}

async function startPicker(options: PickerOptions = {}) {
  const { recipeDir, workspaceDir } = recipeWithPrompts(options.templates);
  const pi = createMockExtensionAPI();
  pi.flagValues.set("recipe", recipeDir);
  const sendUserMessage = vi.fn();
  (pi as any).sendUserMessage = sendUserMessage;
  (pi as any).exec = vi.fn(async () => ({
    stdout: options.gitName ? `${options.gitName}\n` : "",
    stderr: "",
    code: options.gitName ? 0 : 1,
    killed: false,
  }));
  const select = vi.fn(options.select ?? (async () => undefined));
  const ui = {
    notify: vi.fn(),
    select,
    input: vi.fn(async () => options.input),
    setEditorText: vi.fn(),
  };
  const ctx = {
    cwd: workspaceDir,
    hasUI: true,
    mode: options.mode ?? "tui",
    ui,
    isIdle: () => true,
    sessionManager: { getEntries: () => options.entries ?? [] },
    modelRegistry: {
      authStorage: {},
      find: vi.fn((provider: string, id: string) => ({ provider, id })),
    },
  } as any;
  const env = { ...process.env, [SUGGESTIONS_SEED_ENV]: options.seed ?? "test" };
  createRecipesExtension({ env })(pi);
  await pi.emitExtensionEvent(
    { type: "session_start", reason: options.reason ?? "startup" } as any,
    ctx
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  return { pi, ctx, ui, select, sendUserMessage, settle };
}

describe("first-run picker", () => {
  it("asks once in a new TUI session with three numbered templates and a typed row", async () => {
    const { select, settle } = await startPicker();
    await settle();
    expect(select).toHaveBeenCalledTimes(1);
    const [title, choices] = select.mock.calls[0]!;
    expect(title).toBe(SUGGESTIONS_QUESTION);
    expect(choices).toHaveLength(4);
    expect(choices[3]).toBe(`4. ${ASK_USER_TYPED_ANSWER_OPTION}`);
    for (const choice of choices.slice(0, 3)) expect(choice).toMatch(/^\d\. .+/);
  });

  it("offers only marked templates, a random three in file order", async () => {
    const order = ["redline", "respond", "risks", "summarize"];
    for (const seed of ["a", "b", "c", "d", "e"]) {
      const { select, settle } = await startPicker({ seed });
      await settle();
      const shown = (select.mock.calls[0]![1] as string[])
        .slice(0, 3)
        .map((choice) => /\/(\w+)$/.exec(choice)?.[1]);
      expect(shown).toHaveLength(3);
      for (const name of shown) expect(order).toContain(name);
      expect([...shown].sort((a, b) => order.indexOf(a!) - order.indexOf(b!))).toEqual(shown);
    }
  });

  it("pins the three with the seed env var", async () => {
    const first = await startPicker({ seed: "pin" });
    await first.settle();
    const second = await startPicker({ seed: "pin" });
    await second.settle();
    expect(second.select.mock.calls[0]![1]).toEqual(first.select.mock.calls[0]![1]);
  });

  it("labels each option with its description and command", async () => {
    const { select, settle } = await startPicker({
      templates: { "redline.md": TEMPLATES["redline.md"]!, "risks.md": "---\nsuggest: true\n---\n" },
    });
    await settle();
    expect(select.mock.calls[0]![1]).toEqual([
      "1. Redline a contract against the playbook — /redline",
      "2. /risks",
      `3. ${ASK_USER_TYPED_ANSWER_OPTION}`,
    ]);
  });

  it("sends a picked template expanded, with today and the git name filled", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 9));
    const { sendUserMessage, settle, pi } = await startPicker({
      templates: { "redline.md": TEMPLATES["redline.md"]! },
      select: async (_title, choices) => choices[0],
      gitName: "Ada Lovelace",
    });
    await settle();
    expect((pi as any).exec).toHaveBeenCalledWith("git", ["config", "user.name"], expect.anything());
    expect(sendUserMessage).toHaveBeenCalledWith(
      "Redline the attached contract for Ada Lovelace on 2026-11-03."
    );
  });

  it("leaves {{member.name}} when git has no name", async () => {
    const { sendUserMessage, settle } = await startPicker({
      templates: { "redline.md": TEMPLATES["redline.md"]! },
      select: async (_title, choices) => choices[0],
    });
    await settle();
    expect(sendUserMessage.mock.calls[0]![0]).toMatch(
      /^Redline the attached contract for \{\{member\.name\}\} on \d{4}-\d\d-\d\d\.$/
    );
  });

  it("puts a template with a required argument in the editor instead of sending it", async () => {
    const { sendUserMessage, ui, settle } = await startPicker({
      templates: { "summarize.md": TEMPLATES["summarize.md"]! },
      select: async (_title, choices) => choices[0],
    });
    await settle();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(ui.setEditorText).toHaveBeenCalledWith("/summarize ");
  });

  it("sends a typed answer as the first message", async () => {
    const { sendUserMessage, settle } = await startPicker({
      select: async (_title, choices) => choices.at(-1),
      input: "  Compare the two NDAs  ",
    });
    await settle();
    expect(sendUserMessage).toHaveBeenCalledWith("Compare the two NDAs", {
      expandPromptTemplates: true,
    });
  });

  it("sends nothing on Esc", async () => {
    const { select, sendUserMessage, ui, settle } = await startPicker();
    await settle();
    expect(select).toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(ui.setEditorText).not.toHaveBeenCalled();
  });

  it.each([
    ["outside the TUI", { mode: "rpc" }],
    ["in print mode", { mode: "print" }],
    ["on resume", { reason: "resume" }],
    ["on fork", { reason: "fork" }],
    ["when the session has messages", { entries: [{ type: "message" }] }],
    ["without prompt templates", { templates: {} }],
    [
      "when no template is marked",
      { templates: { "notes.md": TEMPLATES["notes.md"]!, "off.md": TEMPLATES["off.md"]! } },
    ],
  ])("does not ask %s", async (_name, options) => {
    const { select, settle } = await startPicker(options as PickerOptions);
    await settle();
    expect(select).not.toHaveBeenCalled();
  });

  it("is skipped by an initial message that arrives first", async () => {
    const { pi, ctx, select, settle } = await startPicker();
    await pi.emitExtensionEvent(
      { type: "input", text: "/redline", source: "interactive" } as any,
      ctx
    );
    await settle();
    expect(select).not.toHaveBeenCalled();
  });

  it("is dismissed by an initial message that arrives while it is open", async () => {
    let dismissed = false;
    const { pi, ctx, select, sendUserMessage, settle } = await startPicker({
      select: (_title, _choices, dialog) =>
        new Promise((resolve) => {
          dialog?.signal?.addEventListener("abort", () => {
            dismissed = true;
            resolve(undefined);
          });
        }),
    });
    await settle();
    expect(select).toHaveBeenCalled();
    await pi.emitExtensionEvent(
      { type: "input", text: "/redline", source: "interactive" } as any,
      ctx
    );
    await settle();
    expect(dismissed).toBe(true);
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("is not dismissed by a message an extension sends", async () => {
    let dismissed = false;
    const { pi, ctx, settle } = await startPicker({
      select: (_title, _choices, dialog) =>
        new Promise(() => {
          dialog?.signal?.addEventListener("abort", () => {
            dismissed = true;
          });
        }),
    });
    await settle();
    await pi.emitExtensionEvent(
      { type: "input", text: "hello", source: "extension" } as any,
      ctx
    );
    expect(dismissed).toBe(false);
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createReviewArtifactsTool,
  formatReviews,
  parseReviews,
  reviewSource,
  tabName,
  REVIEW_ARTIFACTS_TOOL_NAME,
  wantsArtifactReview,
  type ArtifactReview,
} from "../src/artifact-review.js";
import {
  ArtifactViewer,
  artifactViewerExtension,
  wantsArtifactViewer,
} from "../src/artifact-viewer.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
  inverse: (text: string) => text,
};

/**
 * A fake `ctx.ui`: `custom()` builds each component and keeps it, the review
 * list inline and the artifact panel as an overlay, so a test can type into
 * the list and read what the panel shows.
 */
function fakeCtx(
  cwd: string,
  mode: "tui" | "rpc" | "print",
  env: NodeJS.ProcessEnv = {},
) {
  const components: Array<{
    component: Component;
    overlay: boolean;
    closed: boolean;
  }> = [];
  const selects: string[][] = [];
  const answers: { select: string[]; input: string[] } = {
    select: [],
    input: [],
  };
  const ui = {
    custom<T>(
      factory: (
        tui: object,
        theme: object,
        keybindings: object,
        done: (result: T) => void,
      ) => Component,
      options: Record<string, any> = {},
    ): Promise<T> {
      return new Promise<T>((resolvePromise) => {
        const entry = {
          overlay: Boolean(options.overlay),
          closed: false,
        } as (typeof components)[number];
        entry.component = factory(
          { requestRender() {}, terminal: { rows: 20 } },
          theme,
          {},
          (result) => {
            entry.closed = true;
            (entry.component as { dispose?: () => void }).dispose?.();
            resolvePromise(result);
          },
        );
        components.push(entry);
        options.onHandle?.({
          focus() {},
          unfocus() {},
          isFocused: () => false,
          isHidden: () => false,
          setHidden() {},
          hide() {},
          getBounds: () => undefined,
        });
      });
    },
    async select(title: string, options: string[]) {
      selects.push([title, ...options]);
      return answers.select.shift();
    },
    async input() {
      return answers.input.shift();
    },
    notify() {},
  };
  const ctx = {
    cwd,
    mode,
    hasUI: mode !== "print",
    ui,
  } as unknown as ExtensionContext;
  return { ctx, components, selects, answers, env };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "review-"));
  mkdirSync(join(dir, "evals", "cases"), { recursive: true });
  for (const id of ["C1", "C2", "C3"])
    writeFileSync(
      join(dir, "evals", "cases", `${id}.md`),
      `# ${id}\n\nBody of ${id}.\n`,
    );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const items = [
  { path: "evals/cases/C1.md", label: "C1: four questions" },
  { path: "evals/cases/C2.md", label: "C2: vague answer" },
  { path: "evals/cases/C3.md", label: "C3: skips a question" },
];

const viewerOptions = { watchFile: () => () => {}, openExternal: () => {} };

async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function run(mode: "tui" | "rpc" | "print", env: NodeJS.ProcessEnv = {}) {
  const fake = fakeCtx(dir, mode);
  const tool = createReviewArtifactsTool();
  const result = (tool.execute as any)(
    "call-1",
    { title: "The cases", items },
    undefined,
    undefined,
    fake.ctx,
    env,
  );
  return { fake, result: result as Promise<any> };
}

function type(component: Component, keys: string[]) {
  for (const key of keys) component.handleInput?.(key);
}

describe("formatReviews and parseReviews", () => {
  it("round-trip every decision, comment and unopened approval", () => {
    const reviews: ArtifactReview[] = [
      { path: "evals/cases/C1.md", decision: "approved", opened: true },
      {
        path: "evals/cases/C2.md",
        decision: "changes_requested",
        comment: "make it a code check",
        opened: true,
      },
      { path: "evals/cases/C3.md", decision: "approved", opened: false },
      { path: "docs/DESIGN.md", decision: "not_reviewed", opened: false },
    ];
    const text = formatReviews(reviews);
    expect(text.split("\n")[0]).toBe(
      "Reviewed 4 files: 2 approved, 1 with changes requested, 1 not reviewed.",
    );
    expect(text).toContain(
      'evals/cases/C2.md: changes requested — "make it a code check"',
    );
    expect(text).toContain("evals/cases/C3.md: approved (not opened)");
    expect(text).toContain("docs/DESIGN.md: not reviewed (not opened)");
    expect(parseReviews(text)).toEqual(reviews);
  });
});

describe("what the review shows of a file", () => {
  const caseFile = [
    "---",
    "id: C1",
    "inputs:",
    "  - name: job-description.txt",
    "    sha256: abc",
    "check: person",
    "approved_by:",
    "approved_at:",
    "---",
    "",
    "## Situation",
    "",
    "Ready to interview.",
  ].join("\n");

  it("folds a case's front matter into one line", () => {
    const shown = reviewSource(caseFile);
    expect(shown).toMatch(
      /^_check: person · inputs: job-description.txt · not yet approved_/,
    );
    expect(shown).not.toContain("sha256");
    expect(shown).toContain("## Situation");
    expect(
      reviewSource(caseFile.replace("approved_by:", "approved_by: owner")),
    ).toContain("approved by owner");
  });

  it("doesn't take a # line in a code fence for a heading", () => {
    const brief =
      "## Part A\n\nThe job.\n\n```\n# not a heading\n```\n\nStill Part A.\n\n## Part B\n\nTables.";
    const shown = reviewSource(brief, "Part A");
    expect(shown).toContain("Still Part A.");
    expect(shown).not.toContain("Tables.");
  });

  it("shows only the section asked for, to the next heading at its level", () => {
    const brief =
      "# Design\n\n## Part A: what it does\n\nThe job.\n\n### Detail\n\nMore.\n\n## Part B: how it is built\n\nTables.";
    const shown = reviewSource(brief, "Part A");
    expect(shown).toContain("The job.");
    expect(shown).toContain("### Detail");
    expect(shown).not.toContain("Part B");
    expect(reviewSource(brief, "Part C")).toContain('No heading "Part C"');
  });

  it("prefers the heading that matches exactly over one that contains it", () => {
    const brief =
      "## Part A overview\n\nSummary.\n\n## Part A\n\nThe brief.\n\n## Part B\n\nTables.";
    const shown = reviewSource(brief, "part a");
    expect(shown).toContain("The brief.");
    expect(shown).not.toContain("Summary.");
    expect(shown).not.toContain("Tables.");
  });
});

describe("review_artifacts in the terminal", () => {
  const RIGHT = "\x1b[C";
  const DOWN = "\x1b[B";
  const dialog = (fake: ReturnType<typeof fakeCtx>) =>
    fake.components.find((c) => !c.overlay)!.component;
  const shown = (component: Component, width = 120) =>
    component.render(width).join("\n");

  it("shows each file inline, with no panel, and records a decision and comment per file", async () => {
    const { fake, result } = run("tui");
    await flush();
    const review = dialog(fake);
    expect(fake.components.some((c) => c.overlay)).toBe(false);
    expect(shown(review)).toContain("Body of C1.");
    expect(shown(review)).toContain("1. Approve");

    type(review, ["1"]); // approve C1; moves to C2
    expect(shown(review)).toContain("Body of C2.");
    type(review, ["3", "\r"]); // a change request needs a comment: Enter alone does nothing
    expect(shown(review)).toContain("What should change?");
    type(review, [..."code check", "\r"]); // changes on C2; moves to C3
    type(review, [RIGHT, "\r"]); // the Submit tab: submit, C3 left undecided

    const out = await result;
    expect(out.details.reviews).toEqual([
      { path: "evals/cases/C1.md", decision: "approved", opened: true },
      {
        path: "evals/cases/C2.md",
        decision: "changes_requested",
        comment: "code check",
        opened: true,
      },
      { path: "evals/cases/C3.md", decision: "not_reviewed", opened: true },
    ]);
    expect(out.content[0].text).toMatch(
      /^Answer: Reviewed 3 files: 1 approved, 1 with changes requested, 1 not reviewed\./,
    );
  });

  it("names each tab by the label's id, with the full label only under the tabs", async () => {
    const { fake, result } = run("tui");
    await flush();
    const [tabs, , heading] = dialog(fake).render(200).slice(1);
    expect(tabs).toContain(" C1 ");
    expect(tabs).not.toContain("four questions");
    expect(heading).toContain("C1: four questions");
    expect(tabName("The updated brief", "docs/DESIGN.md", 0)).toBe("DESIGN");
    expect(
      tabName("Example candidate interview", "outputs/C1-1-transcript.md", 3),
    ).toBe("C1-1");
    expect(
      tabName("C2 example: probing", "outputs/C2-1-transcript.md", 4),
    ).toBe("C2");
    expect(
      tabName("C4/C5 example: evaluation", "outputs/C4-3-assessment.md", 5),
    ).toBe("C4/C5");
    expect(tabName("Notes", "docs/a-very-long-file-name.md", 6)).toBe("7");
    type(dialog(fake), ["\x1b"]);
    await result;
  });

  it("approves the rest from the Submit tab", async () => {
    const { fake, result } = run("tui");
    await flush();
    const review = dialog(fake);
    type(review, ["\x1b[D", "\x1b[Z"]); // left and Shift+Tab on the first file stay there
    type(review, [RIGHT, RIGHT, RIGHT, RIGHT]); // past the last file to Submit, and no further
    expect(shown(review)).toContain(
      "0 approved · 0 changes requested · 3 not reviewed",
    );
    type(review, [DOWN, "\r"]); // "Approve the rest and submit"
    const reviews = (await result).details.reviews as ArtifactReview[];
    expect(reviews.map((r) => [r.decision, r.opened])).toEqual([
      ["approved", true],
      ["approved", true],
      ["approved", true],
    ]);
  });

  it("goes to the Submit tab once the last file is decided, and submits from there", async () => {
    const { fake, result } = run("tui");
    await flush();
    type(dialog(fake), ["1", "\r", "3", ..."fix it", "\r"]);
    const summary = shown(dialog(fake));
    expect(summary).toContain(
      "2 approved · 1 changes requested · 0 not reviewed",
    );
    expect(summary).toMatch(/C3: skips a question\s+changes requested/);
    expect(summary).toContain('"fix it"');
    type(dialog(fake), ["\r"]);
    const reviews = (await result).details.reviews as ArtifactReview[];
    expect(reviews.map((r) => r.decision)).toEqual([
      "approved",
      "approved",
      "changes_requested",
    ]);
  });

  it("keeps its hint short, and offers scrolling only for a file longer than the box", async () => {
    writeFileSync(
      join(dir, "evals", "cases", "C2.md"),
      Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n\n"),
    );
    const { fake, result } = run("tui");
    await flush();
    const review = dialog(fake);
    const hint = () => review.render(80).at(-1)!;
    expect(hint()).toBe(" ←→ file · Enter choose · Esc cancel");
    expect(review.render(60).every((line) => visibleWidth(line) <= 60)).toBe(
      true,
    );
    type(review, [RIGHT]);
    expect(hint()).toContain("j/k scroll");
    expect(shown(review)).toContain("line 1");
    type(review, ["\x1b[6~"]); // PgDn
    expect(shown(review)).not.toContain("line 1\n");
    type(review, ["k", "k", "k", "k", "k", "k", "k", "k", "k", "k", "k", "k"]); // back up by line
    expect(shown(review)).toContain("line 1");
    // The box takes at most half the terminal (the fake has 20 rows).
    expect(
      review.render(80).filter((line) => line.includes("│")).length,
    ).toBeLessThanOrEqual(10);
    type(review, ["\x1b"]);
    await result;
  });

  it("shows a single file without tabs", async () => {
    const fake = fakeCtx(dir, "tui");
    const tool = createReviewArtifactsTool();
    const result = (tool.execute as any)(
      "call-1",
      { title: "The brief", items: [items[0]] },
      undefined,
      undefined,
      fake.ctx,
    );
    await flush();
    const review = dialog(fake);
    expect(shown(review)).not.toContain("Submit");
    expect(review.render(80).at(-1)).toBe(" Enter choose · Esc cancel");
    type(review, ["\r"]);
    expect((await result).details.reviews).toEqual([
      { path: "evals/cases/C1.md", decision: "approved", opened: true },
    ]);
  });

  it("takes a bracketed paste into a change request, lines joined", async () => {
    const { fake, result } = run("tui");
    await flush();
    const review = dialog(fake);
    type(review, [
      "3",
      "\x1b[200~Fix the setup\nAdd a",
      " regression test\x1b[201~",
      "\r",
    ]);
    type(review, ["1", "1", "\r"]);
    expect((await result).details.reviews[0]).toMatchObject({
      decision: "changes_requested",
      comment: "Fix the setup Add a regression test",
    });
  });

  it("approves with an optional comment", async () => {
    const { fake, result } = run("tui");
    await flush();
    const review = dialog(fake);
    type(review, ["2"]);
    expect(shown(review)).toContain("Comment: ");
    type(review, [..."looks good", "\r"]); // C1 approved with a comment
    type(review, ["2", "\r"]); // C2 approved, the comment left empty
    type(review, ["1", "\r"]); // C3 approved, then submit
    const reviews = (await result).details.reviews as ArtifactReview[];
    expect(reviews.map((r) => [r.decision, r.comment])).toEqual([
      ["approved", "looks good"],
      ["approved", undefined],
      ["approved", undefined],
    ]);
  });

  it("declines when dismissed, approving nothing", async () => {
    const { fake, result } = run("tui");
    await flush();
    type(dialog(fake), ["3", "\x1b", "\x1b"]);
    const out = await result;
    expect(out.details.interrupt.outcome).toEqual({ type: "declined" });
    expect(out.details.reviews).toEqual([]);
  });
});

describe("review_artifacts elsewhere", () => {
  it("asks per file over RPC", async () => {
    const fake = fakeCtx(dir, "rpc");
    fake.answers.select.push("Approve", "Request changes", "Skip");
    fake.answers.input.push("", "", "needs a code check"); // the empty change request is asked again
    const tool = createReviewArtifactsTool();
    const out = await (tool.execute as any)(
      "call-1",
      { title: "The cases", items },
      undefined,
      undefined,
      fake.ctx,
    );
    // The dialog carries the file, since an RPC client sees only what it's sent.
    expect(fake.selects[0]![0]).toMatch(
      /^C1: four questions \(evals\/cases\/C1\.md\)\n\n# C1\n\nBody of C1\./,
    );
    expect(fake.selects[0]!.slice(1)).toEqual([
      "Approve",
      "Request changes",
      "Skip",
    ]);
    expect(out.details.reviews.map((r: ArtifactReview) => r.decision)).toEqual([
      "approved",
      "changes_requested",
      "not_reviewed",
    ]);
  });

  it("never approves on its own in a headless run", async () => {
    const previous = process.env.PI_ASK_USER_AUTO_APPROVE;
    process.env.PI_ASK_USER_AUTO_APPROVE = "1";
    try {
      const fake = fakeCtx(dir, "print");
      const tool = createReviewArtifactsTool();
      const out = await (tool.execute as any)(
        "call-1",
        { title: "The cases", items },
        undefined,
        undefined,
        fake.ctx,
      );
      expect(out.details.interrupt.outcome).toEqual({ type: "declined" });
    } finally {
      if (previous === undefined) delete process.env.PI_ASK_USER_AUTO_APPROVE;
      else process.env.PI_ASK_USER_AUTO_APPROVE = previous;
    }
  });

  it("pauses for a host that sets PI_INTERRUPT_RESUME in the session's env, not process.env", async () => {
    const fake = fakeCtx(dir, "print");
    const tool = createReviewArtifactsTool({ PI_INTERRUPT_RESUME: "1" });
    const out = await (tool.execute as any)(
      "call-1",
      { title: "The cases", items },
      undefined,
      undefined,
      fake.ctx,
    );
    expect(out.details.interrupt.outcome).toEqual({ type: "awaiting_user" });
  });

  it("keeps a multi-line RPC comment on its file's line, so the decision survives", async () => {
    const fake = fakeCtx(dir, "rpc");
    fake.answers.select.push("Request changes", "Approve", "Approve");
    fake.answers.input.push("Fix the setup\nAdd a regression test", "", "");
    const out = await (createReviewArtifactsTool().execute as any)(
      "call-1",
      { title: "The cases", items },
      undefined,
      undefined,
      fake.ctx,
    );
    expect(out.details.reviews[0]).toEqual({
      path: "evals/cases/C1.md",
      decision: "changes_requested",
      comment: "Fix the setup Add a regression test",
      opened: true,
    });
    expect(out.details.reviews).toHaveLength(3);
  });

  it("closes an open artifact panel before the terminal review", async () => {
    const fake = fakeCtx(dir, "tui");
    let closed = 0;
    const tool = createReviewArtifactsTool(undefined, () => {
      closed += 1;
    });
    const result = (tool.execute as any)(
      "call-1",
      { title: "The cases", items },
      undefined,
      undefined,
      fake.ctx,
    );
    await flush();
    expect(closed).toBe(1);
    type(fake.components.find((c) => !c.overlay)!.component, ["\x1b"]);
    await result;
  });

  it("gives a pause/resume host the files to render", async () => {
    const previous = process.env.PI_INTERRUPT_RESUME;
    process.env.PI_INTERRUPT_RESUME = "1";
    try {
      const fake = fakeCtx(dir, "print");
      const tool = createReviewArtifactsTool();
      const out = await (tool.execute as any)(
        "call-1",
        { title: "The cases", items },
        undefined,
        undefined,
        fake.ctx,
      );
      expect(out.details.interrupt.outcome).toEqual({ type: "awaiting_user" });
      expect(out.details.interrupt.metadata).toEqual({
        kind: REVIEW_ARTIFACTS_TOOL_NAME,
        items: items.map(({ path, label }) => ({ path, label })),
      });
    } finally {
      if (previous === undefined) delete process.env.PI_INTERRUPT_RESUME;
      else process.env.PI_INTERRUPT_RESUME = previous;
    }
  });

  it("refuses a file outside the working directory", async () => {
    const fake = fakeCtx(dir, "tui");
    const tool = createReviewArtifactsTool();
    await expect(
      (tool.execute as any)(
        "call-1",
        { title: "x", items: [{ path: "../outside.md" }] },
        undefined,
        undefined,
        fake.ctx,
      ),
    ).rejects.toThrow();
  });
});

describe("registration", () => {
  function registered(tools: string[]) {
    const names: string[] = [];
    const pi = {
      registerTool: (tool: { name: string }) => names.push(tool.name),
      registerCommand() {},
      registerShortcut() {},
      on() {},
    };
    artifactViewerExtension(undefined, viewerOptions, tools)(pi as any);
    return names;
  }

  it("registers only the tools the agent lists", () => {
    expect(registered(["review_artifacts"])).toEqual(["review_artifacts"]);
    expect(registered(["show_artifact"])).toEqual(["show_artifact"]);
    expect(registered(["show_artifact", "review_artifacts"]).sort()).toEqual([
      "review_artifacts",
      "show_artifact",
    ]);
  });

  it("is opted into by listing review_artifacts in tools", () => {
    expect(wantsArtifactReview(["review_artifacts"])).toBe(true);
    expect(wantsArtifactViewer(["review_artifacts"])).toBe(true);
    expect(wantsArtifactReview(["show_artifact"])).toBe(false);
  });
});

describe("a question with the artifact panel open", () => {
  it("scrolls the panel with Shift+Up/Down and PgUp/PgDn, and sets the panel's footer while open", async () => {
    const { showChoiceTui, setArtifactPanelControl } =
      await import("../src/interaction-tui.js");
    const scrolled: string[] = [];
    const hints: Array<string | undefined> = [];
    setArtifactPanelControl({
      scroll: (by) => scrolled.push(by),
      setDialogHint: (hint) => hints.push(hint),
    });
    try {
      const fake = fakeCtx(dir, "tui");
      const answer = showChoiceTui(
        "Approve?",
        [{ label: "Yes" }, { label: "No" }],
        fake.ctx.ui as any,
        undefined,
        {
          multiple: false,
          typedLabel: "type",
        },
      );
      const list = fake.components[0]!.component;
      expect(list.render(120).join("\n")).toContain(
        "Shift+Up/Down scroll the file",
      );
      type(list, ["\x1b[1;2B", "\x1b[1;2A", "\x1b[6~", "\x1b[5~", "1"]);
      expect(scrolled).toEqual([
        "line-down",
        "line-up",
        "page-down",
        "page-up",
      ]);
      expect(await answer).toEqual({ selected: [0] });
      expect(hints).toEqual(["Shift+↑↓ or PgUp/PgDn to scroll", undefined]);
    } finally {
      setArtifactPanelControl(undefined);
    }
  });
});

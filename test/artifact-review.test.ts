import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createReviewArtifactsTool,
  formatReviews,
  parseReviews,
  REVIEW_ARTIFACTS_TOOL_NAME,
  wantsArtifactReview,
  type ArtifactReview,
} from "../src/artifact-review.js";
import { ArtifactViewer, artifactViewerExtension, wantsArtifactViewer } from "../src/artifact-viewer.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
};

/**
 * A fake `ctx.ui`: `custom()` builds each component and keeps it, the review
 * list inline and the artifact panel as an overlay, so a test can type into
 * the list and read what the panel shows.
 */
function fakeCtx(cwd: string, mode: "tui" | "rpc" | "print", env: NodeJS.ProcessEnv = {}) {
  const components: Array<{ component: Component; overlay: boolean; closed: boolean }> = [];
  const selects: string[][] = [];
  const answers: { select: string[]; input: string[] } = { select: [], input: [] };
  const ui = {
    custom<T>(
      factory: (tui: object, theme: object, keybindings: object, done: (result: T) => void) => Component,
      options: Record<string, any> = {}
    ): Promise<T> {
      return new Promise<T>((resolvePromise) => {
        const entry = { overlay: Boolean(options.overlay), closed: false } as (typeof components)[number];
        entry.component = factory({ requestRender() {}, terminal: { rows: 20 } }, theme, {}, (result) => {
          entry.closed = true;
          (entry.component as { dispose?: () => void }).dispose?.();
          resolvePromise(result);
        });
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
  const ctx = { cwd, mode, hasUI: mode !== "print", ui } as unknown as ExtensionContext;
  return { ctx, components, selects, answers, env };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "review-"));
  mkdirSync(join(dir, "evals", "cases"), { recursive: true });
  for (const id of ["C1", "C2", "C3"]) writeFileSync(join(dir, "evals", "cases", `${id}.md`), `# ${id}\n\nBody of ${id}.\n`);
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
  const tool = createReviewArtifactsTool(new ArtifactViewer(viewerOptions));
  const result = (tool.execute as any)("call-1", { title: "The cases", items }, undefined, undefined, fake.ctx, env);
  return { fake, result: result as Promise<any> };
}

function type(component: Component, keys: string[]) {
  for (const key of keys) component.handleInput?.(key);
}

describe("formatReviews and parseReviews", () => {
  it("round-trip every decision, comment and unopened approval", () => {
    const reviews: ArtifactReview[] = [
      { path: "evals/cases/C1.md", decision: "approved", opened: true },
      { path: "evals/cases/C2.md", decision: "changes_requested", comment: "make it a code check", opened: true },
      { path: "evals/cases/C3.md", decision: "approved", opened: false },
      { path: "docs/DESIGN.md", decision: "not_reviewed", opened: false },
    ];
    const text = formatReviews(reviews);
    expect(text.split("\n")[0]).toBe("Reviewed 4 files: 2 approved, 1 with changes requested, 1 not reviewed.");
    expect(text).toContain('evals/cases/C2.md: changes requested — "make it a code check"');
    expect(text).toContain("evals/cases/C3.md: approved (not opened)");
    expect(text).toContain("docs/DESIGN.md: not reviewed (not opened)");
    expect(parseReviews(text)).toEqual(reviews);
  });
});

describe("review_artifacts in the terminal", () => {
  it("shows each file in the panel and records a decision and comment per file", async () => {
    const { fake, result } = run("tui");
    await flush();
    const list = fake.components.find((c) => !c.overlay)!.component;
    const panel = () => fake.components.filter((c) => c.overlay && !c.closed).at(-1)!.component;
    expect(panel().render(80).join("\n")).toContain("Body of C1.");

    type(list, ["a", "\r"]); // approve C1, no comment; moves to C2
    await flush();
    expect(panel().render(80).join("\n")).toContain("Body of C2.");
    type(list, ["c", ..."code check", "\r"]); // changes on C2
    type(list, ["\r"]); // submit; C3 left undecided

    const out = await result;
    expect(out.details.reviews).toEqual([
      { path: "evals/cases/C1.md", decision: "approved", opened: true },
      { path: "evals/cases/C2.md", decision: "changes_requested", comment: "code check", opened: true },
      { path: "evals/cases/C3.md", decision: "not_reviewed", opened: true },
    ]);
    expect(out.content[0].text).toMatch(/^Answer: Reviewed 3 files: 1 approved, 1 with changes requested, 1 not reviewed\./);
    expect(fake.components.every((c) => c.closed)).toBe(true);
  });

  it("approves the rest with A, saying which files were never opened", async () => {
    const { fake, result } = run("tui");
    await flush();
    const list = fake.components.find((c) => !c.overlay)!.component;
    type(list, ["A", "\r"]);
    const reviews = (await result).details.reviews as ArtifactReview[];
    expect(reviews.map((r) => [r.decision, r.opened])).toEqual([
      ["approved", true],
      ["approved", false],
      ["approved", false],
    ]);
  });

  it("declines when dismissed, approving nothing", async () => {
    const { fake, result } = run("tui");
    await flush();
    type(fake.components.find((c) => !c.overlay)!.component, ["a", "\x1b", "\x1b"]);
    const out = await result;
    expect(out.details.interrupt.outcome).toEqual({ type: "declined" });
    expect(out.details.reviews).toEqual([]);
  });
});

describe("review_artifacts elsewhere", () => {
  it("asks per file over RPC", async () => {
    const fake = fakeCtx(dir, "rpc");
    fake.answers.select.push("Approve", "Request changes", "Skip");
    fake.answers.input.push("", "needs a code check");
    const tool = createReviewArtifactsTool(new ArtifactViewer(viewerOptions));
    const out = await (tool.execute as any)("call-1", { title: "The cases", items }, undefined, undefined, fake.ctx);
    expect(fake.selects[0]).toEqual(["C1: four questions (evals/cases/C1.md)", "Approve", "Request changes", "Skip"]);
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
      const tool = createReviewArtifactsTool(new ArtifactViewer(viewerOptions));
      const out = await (tool.execute as any)("call-1", { title: "The cases", items }, undefined, undefined, fake.ctx);
      expect(out.details.interrupt.outcome).toEqual({ type: "declined" });
    } finally {
      if (previous === undefined) delete process.env.PI_ASK_USER_AUTO_APPROVE;
      else process.env.PI_ASK_USER_AUTO_APPROVE = previous;
    }
  });

  it("gives a pause/resume host the files to render", async () => {
    const previous = process.env.PI_INTERRUPT_RESUME;
    process.env.PI_INTERRUPT_RESUME = "1";
    try {
      const fake = fakeCtx(dir, "print");
      const tool = createReviewArtifactsTool(new ArtifactViewer(viewerOptions));
      const out = await (tool.execute as any)("call-1", { title: "The cases", items }, undefined, undefined, fake.ctx);
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
    const tool = createReviewArtifactsTool(new ArtifactViewer(viewerOptions));
    await expect(
      (tool.execute as any)("call-1", { title: "x", items: [{ path: "../outside.md" }] }, undefined, undefined, fake.ctx)
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
    expect(registered(["show_artifact", "review_artifacts"]).sort()).toEqual(["review_artifacts", "show_artifact"]);
  });

  it("is opted into by listing review_artifacts in tools", () => {
    expect(wantsArtifactReview(["review_artifacts"])).toBe(true);
    expect(wantsArtifactViewer(["review_artifacts"])).toBe(true);
    expect(wantsArtifactReview(["show_artifact"])).toBe(false);
  });
});

describe("a question with the artifact panel open", () => {
  it("scrolls the panel with PgUp/PgDn and says so in its hint", async () => {
    const { showChoiceTui, setArtifactPanelScroll } = await import("../src/interaction-tui.js");
    const scrolled: string[] = [];
    setArtifactPanelScroll((page) => scrolled.push(page));
    try {
      const fake = fakeCtx(dir, "tui");
      const answer = showChoiceTui("Approve?", [{ label: "Yes" }, { label: "No" }], fake.ctx.ui as any, undefined, {
        multiple: false,
        typedLabel: "type",
      });
      const list = fake.components[0]!.component;
      expect(list.render(120).join("\n")).toContain("PgUp/PgDn scroll the file");
      type(list, ["\x1b[6~", "\x1b[5~", "1"]);
      expect(scrolled).toEqual(["page-down", "page-up"]);
      expect(await answer).toEqual({ selected: [0] });
    } finally {
      setArtifactPanelScroll(undefined);
    }
  });
});

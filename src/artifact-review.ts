/**
 * `review_artifacts`: the user reviews several markdown files the agent wrote,
 * one decision per file, as in a pull request review: approve or request
 * changes, each with an optional comment.
 *
 * It is a Recipes interaction (docs/interactions.md), so it works on every
 * host. In Pi's terminal a list replaces the editor and the artifact panel on
 * the right shows the file under the cursor; over RPC each file is a select
 * and an optional comment; a pause/resume host renders its own review widget
 * from `details.interrupt` (`metadata.kind` is `review_artifacts`) and resumes
 * with `{ answer }` in the text format `formatReviews` writes.
 */

import type {
  ExtensionContext,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

import { type ArtifactViewer, resolveArtifactPath, type ResolvedArtifactPath } from "./artifact-viewer.js";
import { DIALOG_PANEL_HINT, panelScrollFor, printable, withoutLastCharacter } from "./interaction-tui.js";
import { askUser, type AskUserOutcome } from "./interactions.js";

export const REVIEW_ARTIFACTS_TOOL_NAME = "review_artifacts";

/** At most this many files in one review, so the user can get through it. */
export const MAX_REVIEW_ITEMS = 12;

export type ReviewDecision = "approved" | "changes_requested" | "not_reviewed";

/** One file's outcome. `opened` says whether the user had it on screen. */
export interface ArtifactReview {
  path: string;
  decision: ReviewDecision;
  comment?: string;
  opened: boolean;
}

const description = [
  "Ask the user to review several markdown files you wrote (a brief, test cases, a design), one decision per file: approve, with an optional comment, or request changes, saying what to change.",
  "In Pi's terminal the user steps through the files with each one shown in the panel on the right; other hosts render their own review. Prefer it to asking for approval of files in plain text.",
  `Give 1 to ${MAX_REVIEW_ITEMS} files, in reading order, with a short label for each. Paths are relative to the working directory; only markdown files can be reviewed.`,
  "The result lists each file's decision and comment. Record an approval only for a file the result says was approved, and change any file with changes requested, then review it again.",
].join("\n");

const parameters = Type.Object(
  {
    title: Type.String({
      description: 'What is being reviewed, e.g. "The interview agent\'s cases".',
    }),
    items: Type.Array(
      Type.Object(
        {
          path: Type.String({ description: "A markdown file, relative to the working directory." }),
          label: Type.Optional(
            Type.String({ description: 'A short label, e.g. "C2: the candidate gives a vague answer".' })
          ),
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: MAX_REVIEW_ITEMS }
    ),
  },
  { additionalProperties: false }
);

export type ReviewArtifactsParams = Static<typeof parameters>;

interface ReviewItem {
  target: ResolvedArtifactPath;
  label: string;
}

const DECISION_TEXT: Record<ReviewDecision, string> = {
  approved: "approved",
  changes_requested: "changes requested",
  not_reviewed: "not reviewed",
};

/**
 * The answer text the model receives, one line per file after a tally. A
 * pause/resume host resumes with this same text as `{ answer }`.
 */
export function formatReviews(reviews: readonly ArtifactReview[]): string {
  const count = (decision: ReviewDecision) => reviews.filter((r) => r.decision === decision).length;
  const lines = [
    `Reviewed ${reviews.length} file${reviews.length === 1 ? "" : "s"}: ${count("approved")} approved, ${count("changes_requested")} with changes requested, ${count("not_reviewed")} not reviewed.`,
  ];
  for (const review of reviews) {
    const comment = review.comment ? ` — "${review.comment}"` : "";
    const unopened = review.opened ? "" : " (not opened)";
    lines.push(`${review.path}: ${DECISION_TEXT[review.decision]}${unopened}${comment}`);
  }
  return lines.join("\n");
}

/** Read the reviews back from `formatReviews` text, as a host's resume carries it. */
export function parseReviews(text: string): ArtifactReview[] {
  const reviews: ArtifactReview[] = [];
  for (const line of text.split("\n").slice(1)) {
    const match = /^(.+?): (approved|changes requested|not reviewed)( \(not opened\))?(?: — "(.*)")?$/.exec(line);
    if (!match) continue;
    const decision = (Object.keys(DECISION_TEXT) as ReviewDecision[]).find((d) => DECISION_TEXT[d] === match[2])!;
    reviews.push({
      path: match[1]!,
      decision,
      opened: !match[3],
      ...(match[4] ? { comment: match[4] } : {}),
    });
  }
  return reviews;
}

interface ReviewState {
  decision?: Exclude<ReviewDecision, "not_reviewed">;
  comment?: string;
}

/**
 * The terminal review: a list in place of the editor, the file under the
 * cursor in the artifact panel. Resolves with one review per file, or null
 * when the user dismisses it.
 */
export function showReviewTui(
  title: string,
  items: readonly ReviewItem[],
  ui: ExtensionUIContext,
  ctx: ExtensionContext,
  viewer: ArtifactViewer,
  signal: AbortSignal | undefined
): Promise<ArtifactReview[] | null> {
  return ui.custom<ArtifactReview[] | null>((tui, theme: Theme, _keybindings, done) => {
    const states: ReviewState[] = items.map(() => ({}));
    const opened = new Set<number>();
    let active = 0;
    let commenting: Exclude<ReviewDecision, "not_reviewed"> | undefined;
    let draft = "";
    let settled = false;

    const finish = (result: ArtifactReview[] | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      viewer.close();
      done(result);
    };
    const cancel = () => finish(null);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) queueMicrotask(cancel);

    const refresh = () => tui.requestRender();
    const showActive = () => {
      opened.add(active);
      viewer.show(ctx, items[active]!.target);
      viewer.setDialogHint(`${DIALOG_PANEL_HINT}, or j/k`);
      refresh();
    };
    const move = (delta: number) => {
      active = (active + delta + items.length) % items.length;
      showActive();
    };
    const nextUndecided = () => {
      for (let step = 1; step <= items.length; step += 1) {
        const index = (active + step) % items.length;
        if (!states[index]!.decision) {
          active = index;
          showActive();
          return;
        }
      }
      refresh();
    };
    const results = (): ArtifactReview[] =>
      items.map((item, index) => {
        const state = states[index]!;
        return {
          path: item.target.relativePath,
          decision: state.decision ?? "not_reviewed",
          opened: opened.has(index),
          ...(state.comment ? { comment: state.comment } : {}),
        };
      });
    const decided = () => states.filter((s) => s.decision).length;

    queueMicrotask(showActive);

    return {
      render(width: number): string[] {
        const lines: string[] = [];
        const add = (line: string) => lines.push(truncateToWidth(line, width));
        const heading = ` Review: ${title} `;
        const tally = ` ${decided()}/${items.length} decided `;
        add(theme.fg("accent", `-${heading}${"-".repeat(Math.max(0, width - heading.length - tally.length - 1))}${tally}`));
        items.forEach((item, index) => {
          const state = states[index]!;
          const mark =
            state.decision === "approved"
              ? theme.fg("success", "✓")
              : state.decision === "changes_requested"
                ? theme.fg("warning", "✎")
                : theme.fg("dim", "○");
          const pointer = index === active ? theme.fg("accent", " > ") : "   ";
          const name = theme.fg(index === active ? "accent" : "text", item.label);
          const comment = state.comment ? theme.fg("dim", `  "${state.comment}"`) : "";
          add(`${pointer}${mark} ${name}${comment}`);
        });
        lines.push("");
        if (commenting) {
          const prompt =
            commenting === "approved"
              ? `Approve ${items[active]!.label}. Comment (optional): `
              : `Request changes on ${items[active]!.label}. What should change? `;
          add(` ${theme.fg("text", prompt)}${theme.fg("accent", `${draft}█`)}`);
          const needsText = commenting === "changes_requested" && !draft.trim();
          add(theme.fg("dim", needsText ? " Type what should change · Esc back" : " Enter save · Esc back"));
        } else {
          // Wrapped, never cut off: the keys are the only way to finish.
          const keys = ["↑↓ file", "Shift+↑↓ or j/k scroll", "a approve", "c request changes", "A approve the rest", "Enter submit", "Esc cancel"];
          let line = "";
          for (const key of keys) {
            const next = line ? `${line} · ${key}` : key;
            if (line && next.length + 1 > width) {
              add(theme.fg("dim", ` ${line}`));
              line = key;
            } else line = next;
          }
          if (line) add(theme.fg("dim", ` ${line}`));
        }
        return lines;
      },
      invalidate() {},
      handleInput(data: string) {
        if (commenting) {
          if (matchesKey(data, Key.escape)) {
            commenting = undefined;
            draft = "";
          } else if (matchesKey(data, Key.enter)) {
            const comment = draft.trim();
            // A change request says what to change, or the agent has nothing to act on.
            if (commenting === "changes_requested" && !comment) return;
            states[active] = { decision: commenting, ...(comment ? { comment } : {}) };
            commenting = undefined;
            draft = "";
            // Every file decided: nothing is left to do, so submit.
            if (decided() === items.length) finish(results());
            else nextUndecided();
            return;
          } else if (matchesKey(data, Key.backspace)) {
            draft = withoutLastCharacter(draft);
          } else {
            const text = printable(data);
            if (text) draft += text.replace(/[\r\n\t]+/g, " ");
          }
          refresh();
          return;
        }
        const by = panelScrollFor(data);
        if (by) viewer.scroll(by);
        else if (matchesKey(data, Key.down) || matchesKey(data, Key.tab) || matchesKey(data, Key.ctrl("n"))) move(1);
        else if (matchesKey(data, Key.up) || matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.ctrl("p"))) move(-1);
        else if (data === "j") viewer.scroll("line-down");
        else if (data === "k") viewer.scroll("line-up");
        else if (matchesKey(data, Key.space)) viewer.scroll("page-down");
        else if (data === "a") {
          commenting = "approved";
          refresh();
        } else if (data === "c" || data === "r") {
          commenting = "changes_requested";
          refresh();
        } else if (data === "A") {
          for (const state of states) if (!state.decision) state.decision = "approved";
          finish(results());
        } else if (matchesKey(data, Key.enter)) finish(results());
        else if (matchesKey(data, Key.escape)) finish(null);
      },
    };
  });
}

/** The RPC review: per file, a select and an optional comment. */
async function reviewOverDialogs(
  items: readonly ReviewItem[],
  ui: ExtensionUIContext,
  dialog: ExtensionUIDialogOptions
): Promise<ArtifactReview[] | null> {
  const reviews: ArtifactReview[] = [];
  for (const item of items) {
    const choice = await ui.select(
      `${item.label} (${item.target.relativePath})`,
      ["Approve", "Request changes", "Skip"],
      dialog
    );
    if (choice === undefined) return null;
    if (choice === "Skip") {
      reviews.push({ path: item.target.relativePath, decision: "not_reviewed", opened: true });
      continue;
    }
    let comment: string | undefined;
    if (choice === "Approve") {
      comment = (await ui.input("Comment (optional)", "", dialog))?.trim();
    } else {
      // A change request says what to change; dismissing the prompt cancels the review.
      while (!comment) {
        const typed = await ui.input("What should change?", "", dialog);
        if (typed === undefined) return null;
        comment = typed.trim();
      }
    }
    reviews.push({
      path: item.target.relativePath,
      decision: choice === "Approve" ? "approved" : "changes_requested",
      opened: true,
      ...(comment ? { comment } : {}),
    });
  }
  return reviews;
}

function answered(reviews: ArtifactReview[] | null): AskUserOutcome {
  return reviews ? { type: "answered", answer: formatReviews(reviews) } : { type: "declined" };
}

/** Build the tool over a session's viewer. */
export function createReviewArtifactsTool(viewer: ArtifactViewer): ToolDefinition {
  const tool: ToolDefinition<typeof parameters> = {
    name: REVIEW_ARTIFACTS_TOOL_NAME,
    label: "Review artifacts",
    description,
    promptSnippet: "Ask the user to review files you wrote, one decision per file",
    promptGuidelines: [
      "When the user must approve several markdown files you wrote (cases, a brief), ask with review_artifacts instead of asking in plain text.",
    ],
    parameters,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const items: ReviewItem[] = params.items.map((item) => {
        const target = resolveArtifactPath(ctx.cwd, item.path);
        return { target, label: item.label?.trim() || target.relativePath };
      });
      const result = await askUser(
        {
          reason: "review",
          message: params.title,
          metadata: {
            kind: REVIEW_ARTIFACTS_TOOL_NAME,
            items: items.map((item) => ({ path: item.target.relativePath, label: item.label })),
          },
          display: {
            kind: REVIEW_ARTIFACTS_TOOL_NAME,
            title: params.title,
            sections: items.map((item) => ({ title: item.label, body: item.target.relativePath })),
          },
        },
        {
          toolCallId,
          ctx,
          signal,
          interactive: async (ui, dialog) =>
            answered(
              ctx.mode === "tui"
                ? await showReviewTui(params.title, items, ui, ctx, viewer, signal)
                : await reviewOverDialogs(items, ui, dialog)
            ),
        }
      );
      const reviews = result.outcome.type === "answered" && result.outcome.answer ? parseReviews(result.outcome.answer) : [];
      return { content: result.content, details: { ...result.details, reviews } };
    },
  };
  return tool as unknown as ToolDefinition;
}

/** Whether the agent opted into the review. */
export function wantsArtifactReview(agentTools: readonly string[]): boolean {
  return agentTools.includes(REVIEW_ARTIFACTS_TOOL_NAME);
}

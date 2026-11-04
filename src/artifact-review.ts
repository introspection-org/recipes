/**
 * `review_artifacts`: the user reviews several markdown files the agent wrote,
 * one decision per file, as in a pull request review: approve or request
 * changes, each with an optional comment.
 *
 * It is a Recipes interaction (docs/interactions.md), so it works on every
 * host. In Pi's terminal it is inline in place of the editor, each file shown
 * in the dialog itself; over RPC each file is a select
 * and an optional comment; a pause/resume host renders its own review widget
 * from `details.interrupt` (`metadata.kind` is `review_artifacts`) and resumes
 * with `{ answer }` in the text format `formatReviews` writes.
 */

import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";

import {
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

import {
  resolveArtifactPath,
  type ResolvedArtifactPath,
} from "./artifact-viewer.js";
import { artifactMarkdownTheme } from "./artifact-viewer-tui.js";
import {
  type ArtifactPanelScrollBy,
  PASTE_END,
  PASTE_START,
  panelScrollFor,
  printable,
  withoutLastCharacter,
} from "./interaction-tui.js";
import { askUser, type AskUserOutcome } from "./interactions.js";

export const REVIEW_ARTIFACTS_TOOL_NAME = "review_artifacts";

/** At most this many files in one review, so the user can get through it. */
export const MAX_REVIEW_ITEMS = 20;

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
  "The result lists each file's decision and comment. Record an approval only for a file the result says was approved, and change any file with changes requested, then review it again. When a change request doesn't say what to change, ask the user about that file before editing it.",
].join("\n");

const parameters = Type.Object(
  {
    title: Type.String({
      description:
        'What is being reviewed, e.g. "The interview agent\'s cases".',
    }),
    items: Type.Array(
      Type.Object(
        {
          path: Type.String({
            description: "A markdown file, relative to the working directory.",
          }),
          label: Type.Optional(
            Type.String({
              description:
                'A short label, e.g. "C2: the candidate gives a vague answer".',
            }),
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: MAX_REVIEW_ITEMS },
    ),
  },
  { additionalProperties: false },
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
  const count = (decision: ReviewDecision) =>
    reviews.filter((r) => r.decision === decision).length;
  const lines = [
    `Reviewed ${reviews.length} file${reviews.length === 1 ? "" : "s"}: ${count("approved")} approved, ${count("changes_requested")} with changes requested, ${count("not_reviewed")} not reviewed.`,
  ];
  for (const review of reviews) {
    // One line per file: the answer is parsed line by line, so a comment's own newlines are folded.
    const text = review.comment?.replace(/\s+/g, " ").trim();
    const comment = text ? ` — "${text}"` : "";
    const unopened = review.opened ? "" : " (not opened)";
    lines.push(
      `${review.path}: ${DECISION_TEXT[review.decision]}${unopened}${comment}`,
    );
  }
  return lines.join("\n");
}

/** Read the reviews back from `formatReviews` text, as a host's resume carries it. */
export function parseReviews(text: string): ArtifactReview[] {
  const reviews: ArtifactReview[] = [];
  for (const line of text.split("\n").slice(1)) {
    const match =
      /^(.+?): (approved|changes requested|not reviewed)( \(not opened\))?(?: — "(.*)")?$/.exec(
        line,
      );
    if (!match) continue;
    const decision = (Object.keys(DECISION_TEXT) as ReviewDecision[]).find(
      (d) => DECISION_TEXT[d] === match[2],
    )!;
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

/** A tab's name: the label's id before a colon ("C1" from "C1: four questions"), else its number. */
export function tabName(label: string, index: number): string {
  const id = label.split(":")[0]!.trim();
  return label.includes(":") && id.length > 0 && id.length <= 12
    ? id
    : String(index + 1);
}

/**
 * The terminal review, inline in place of the editor: a tab per file (and a
 * Submit tab) when there are several, the file itself in a box, and Approve or
 * Request changes under it. Resolves with one review per file, or null when the
 * user dismisses it.
 */
export function showReviewTui(
  title: string,
  items: readonly ReviewItem[],
  ui: ExtensionUIContext,
  signal: AbortSignal | undefined,
): Promise<ArtifactReview[] | null> {
  return ui.custom<ArtifactReview[] | null>(
    (tui, theme: Theme, _keybindings, done) => {
      const states: ReviewState[] = items.map(() => ({}));
      const opened = new Set<number>([0]);
      const scrolls = items.map(() => 0);
      const documents = new Map<number, Markdown>();
      const several = items.length > 1;
      // The Submit tab sits after the files.
      let active = 0;
      let option = 0;
      let commenting = false;
      let draft = "";
      let pasting = false;
      let settled = false;
      let lastBodyHeight = 1;
      let lastMaxScroll = 0;

      const finish = (result: ArtifactReview[] | null) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", cancel);
        done(result);
      };
      const cancel = () => finish(null);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) queueMicrotask(cancel);

      const refresh = () => tui.requestRender();
      const onSubmitTab = () => several && active === items.length;
      const decided = () => states.filter((state) => state.decision).length;
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
      const go = (index: number) => {
        active = Math.min(several ? items.length : 0, Math.max(0, index));
        if (active < items.length) opened.add(active);
        option = 0;
        refresh();
      };
      const nextUndecided = () => {
        for (let step = 1; step <= items.length; step += 1) {
          const index = (active + step) % items.length;
          if (!states[index]!.decision) return go(index);
        }
        go(items.length);
      };
      const decide = (
        decision: Exclude<ReviewDecision, "not_reviewed">,
        comment?: string,
      ) => {
        states[active] = { decision, ...(comment ? { comment } : {}) };
        // A single file has nothing more to decide; several end on the Submit tab, as a review does.
        if (!several) finish(results());
        else nextUndecided();
      };
      const options = (): string[] =>
        onSubmitTab()
          ? decided() < items.length
            ? ["Submit", "Approve the rest and submit"]
            : ["Submit"]
          : ["Approve", "Request changes"];
      const choose = (index: number) => {
        if (onSubmitTab()) {
          if (index === 1)
            for (const state of states)
              if (!state.decision) state.decision = "approved";
          finish(results());
        } else if (index === 0) decide("approved");
        else {
          commenting = true;
          draft = states[active]!.comment ?? "";
          refresh();
        }
      };
      const document = (index: number): Markdown => {
        let markdown = documents.get(index);
        if (!markdown) {
          let source: string;
          try {
            source = readFileSync(items[index]!.target.absolutePath, "utf8");
          } catch {
            source = "_This file doesn't exist._";
          }
          markdown = new Markdown(source, 0, 0, artifactMarkdownTheme(theme));
          documents.set(index, markdown);
        }
        return markdown;
      };
      const scroll = (by: ArtifactPanelScrollBy) => {
        if (onSubmitTab()) return;
        const page = Math.max(1, lastBodyHeight - 1);
        const delta =
          by === "line-up"
            ? -1
            : by === "line-down"
              ? 1
              : by === "page-up"
                ? -page
                : page;
        scrolls[active] = Math.min(
          lastMaxScroll,
          Math.max(0, scrolls[active]! + delta),
        );
        refresh();
      };
      const mark = (index: number) => {
        const decision = states[index]!.decision;
        return decision === "approved"
          ? "✓"
          : decision === "changes_requested"
            ? "✎"
            : "○";
      };

      return {
        render(width: number): string[] {
          const lines: string[] = [];
          const add = (line = "") => lines.push(truncateToWidth(line, width));
          const rule = theme.fg("accent", "─".repeat(Math.max(0, width)));
          add(rule);
          if (several) {
            const tabs = items.map((item, index) => {
              const text = ` ${mark(index)} ${tabName(item.label, index)} `;
              return index === active
                ? theme.inverse(theme.fg("accent", text))
                : theme.fg(states[index]!.decision ? "success" : "text", text);
            });
            const submit = ` ✔ Submit `;
            tabs.push(
              onSubmitTab()
                ? theme.inverse(theme.fg("accent", submit))
                : theme.fg("dim", submit),
            );
            add(` ${title}  ${tabs.join(" ")}`);
          } else add(` ${theme.bold(title)}`);
          add();
          const inner = Math.max(10, width - 4);
          const border = (text: string) => theme.fg("dim", text);
          let body: string[];
          let scrollable = false;
          if (onSubmitTab()) {
            const count = (decision: ReviewDecision) =>
              items.filter(
                (_, index) =>
                  (states[index]!.decision ?? "not_reviewed") === decision,
              ).length;
            add(
              theme.bold(" Summary") +
                theme.fg(
                  "dim",
                  `  ${count("approved")} approved · ${count("changes_requested")} changes requested · ${count("not_reviewed")} not reviewed`,
                ),
            );
            body = [];
            items.forEach((item, index) => {
              const state = states[index]!;
              const [icon, word, color] =
                state.decision === "approved"
                  ? (["✓", "approved", "success"] as const)
                  : state.decision === "changes_requested"
                    ? (["✎", "changes requested", "warning"] as const)
                    : (["○", "not reviewed, so not approved", "dim"] as const);
              body.push(
                `${theme.fg(color, icon)} ${item.label}  ${theme.fg(color, word)}`,
              );
              if (state.comment)
                for (const line of wrapTextWithAnsi(
                  `"${state.comment}"`,
                  Math.max(10, inner - 2),
                ))
                  body.push(`  ${theme.fg("dim", line)}`);
            });
          } else {
            const item = items[active]!;
            add(
              theme.bold(` ${item.label}`) +
                theme.fg("dim", `  ${item.target.relativePath}`),
            );
            body = document(active).render(inner);
            scrollable = true;
          }
          const rows = tui.terminal?.rows ?? 24;
          lastBodyHeight = Math.max(4, Math.min(body.length, rows - 14));
          lastMaxScroll = scrollable
            ? Math.max(0, body.length - lastBodyHeight)
            : 0;
          const top = scrollable
            ? Math.min(scrolls[active]!, lastMaxScroll)
            : 0;
          add(border(` ┌${"─".repeat(inner + 1)}`));
          for (const line of body.slice(top, top + lastBodyHeight))
            add(`${border(" │ ")}${line}`);
          const more =
            lastMaxScroll > 0
              ? ` ${top + 1}-${Math.min(body.length, top + lastBodyHeight)} of ${body.length} `
              : "";
          add(
            border(
              ` └${"─".repeat(Math.max(0, inner + 1 - more.length))}${more}`,
            ),
          );
          add();
          if (commenting) {
            add(
              ` ${theme.fg("text", "What should change? ")}${theme.fg("accent", `${draft}█`)}`,
            );
            add(
              theme.fg(
                "dim",
                draft.trim()
                  ? " Enter save · Esc back"
                  : " Type what should change · Esc back",
              ),
            );
            return lines;
          }
          options().forEach((label, index) => {
            const pointer = index === option ? theme.fg("accent", "❯ ") : "  ";
            add(
              ` ${pointer}${theme.fg(index === option ? "accent" : "text", `${index + 1}. ${label}`)}`,
            );
          });
          add();
          const keys = [
            several ? "←→ file" : undefined,
            "Enter choose",
            lastMaxScroll > 0 && !onSubmitTab()
              ? "PgUp/PgDn scroll"
              : undefined,
            "Esc cancel",
          ];
          add(theme.fg("dim", ` ${keys.filter(Boolean).join(" · ")}`));
          return lines;
        },
        invalidate() {
          for (const markdown of documents.values()) markdown.invalidate();
        },
        handleInput(data: string) {
          if (commenting) {
            if (pasting || data.includes(PASTE_START)) {
              // A bracketed paste can arrive over several events: take its text, lines joined, until the end marker.
              pasting = !data.includes(PASTE_END);
              draft += data
                .replace(PASTE_START, "")
                .replace(PASTE_END, "")
                .replace(/\s+/g, " ")
                // eslint-disable-next-line no-control-regex
                .replace(/[\x00-\x1f\x7f]/g, "");
              refresh();
              return;
            }
            if (matchesKey(data, Key.escape)) {
              commenting = false;
              draft = "";
            } else if (matchesKey(data, Key.enter)) {
              const comment = draft.trim();
              // A change request says what to change, or the agent has nothing to act on.
              if (!comment) return;
              commenting = false;
              draft = "";
              decide("changes_requested", comment);
              return;
            } else if (matchesKey(data, Key.backspace)) {
              draft = withoutLastCharacter(draft);
            } else {
              // Unbracketed multi-line input: join the lines before checking it's printable.
              const text = printable(data.replace(/[\r\n\t]+/g, " "));
              if (text) draft += text;
            }
            refresh();
            return;
          }
          const by = panelScrollFor(data);
          if (by) scroll(by);
          else if (
            several &&
            (matchesKey(data, Key.right) || matchesKey(data, Key.tab))
          )
            go(active + 1);
          else if (
            several &&
            (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab")))
          )
            go(active - 1);
          else if (matchesKey(data, Key.down)) {
            option = Math.min(options().length - 1, option + 1);
            refresh();
          } else if (matchesKey(data, Key.up)) {
            option = Math.max(0, option - 1);
            refresh();
          } else if (/^[1-9]$/.test(data) && Number(data) <= options().length)
            choose(Number(data) - 1);
          else if (matchesKey(data, Key.enter)) choose(option);
          else if (matchesKey(data, Key.escape)) finish(null);
        },
      };
    },
  );
}

/** The RPC review: per file, a select and an optional comment. */
async function reviewOverDialogs(
  items: readonly ReviewItem[],
  ui: ExtensionUIContext,
  dialog: ExtensionUIDialogOptions,
): Promise<ArtifactReview[] | null> {
  const reviews: ArtifactReview[] = [];
  for (const item of items) {
    const choice = await ui.select(
      `${item.label} (${item.target.relativePath})`,
      ["Approve", "Request changes", "Skip"],
      dialog,
    );
    if (choice === undefined) return null;
    if (choice === "Skip") {
      reviews.push({
        path: item.target.relativePath,
        decision: "not_reviewed",
        opened: true,
      });
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
  return reviews
    ? { type: "answered", answer: formatReviews(reviews) }
    : { type: "declined" };
}

/** Build the tool over a session's viewer. */
export function createReviewArtifactsTool(
  env?: NodeJS.ProcessEnv,
): ToolDefinition {
  const tool: ToolDefinition<typeof parameters> = {
    name: REVIEW_ARTIFACTS_TOOL_NAME,
    label: "Review artifacts",
    description,
    promptSnippet:
      "Ask the user to review files you wrote, one decision per file",
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
            items: items.map((item) => ({
              path: item.target.relativePath,
              label: item.label,
            })),
          },
          display: {
            kind: REVIEW_ARTIFACTS_TOOL_NAME,
            title: params.title,
            sections: items.map((item) => ({
              title: item.label,
              body: item.target.relativePath,
            })),
          },
        },
        {
          toolCallId,
          ctx,
          signal,
          ...(env ? { env } : {}),
          interactive: async (ui, dialog) =>
            answered(
              ctx.mode === "tui"
                ? await showReviewTui(params.title, items, ui, signal)
                : await reviewOverDialogs(items, ui, dialog),
            ),
        },
      );
      const reviews =
        result.outcome.type === "answered" && result.outcome.answer
          ? parseReviews(result.outcome.answer)
          : [];
      return {
        content: result.content,
        details: { ...result.details, reviews },
      };
    },
  };
  return tool as unknown as ToolDefinition;
}

/** Whether the agent opted into the review. */
export function wantsArtifactReview(agentTools: readonly string[]): boolean {
  return agentTools.includes(REVIEW_ARTIFACTS_TOOL_NAME);
}

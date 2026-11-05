/**
 * `review_artifacts`: the user reviews several markdown files the agent wrote,
 * one decision per file, as in a pull request review: approve or request
 * changes, each with an optional comment.
 *
 * It is a Recipes interaction (docs/interactions.md), so it works on every
 * host. In Pi's terminal it is inline in place of the editor, each file shown
 * in the dialog itself (`./artifact-review-tui.ts`); over RPC each file is a select
 * and an optional comment; a pause/resume host renders its own review widget
 * from `details.interrupt` (`metadata.kind` is `review_artifacts`) and resumes
 * with `{ answer }` in the text format `formatReviews` writes.
 */

import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";

import { Type } from "typebox";

import { showReviewTui, type ReviewDocument } from "./artifact-review-tui.js";
import {
  resolveArtifactPath,
  type ResolvedArtifactPath,
} from "./artifact-viewer.js";
import { askUser, type AskUserOutcome } from "./interactions.js";

export const REVIEW_ARTIFACTS_TOOL_NAME = "review_artifacts";

/** At most this many files in one review, so the user can get through it. */
const MAX_REVIEW_ITEMS = 20;

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
          section: Type.Optional(
            Type.String({
              description:
                'The heading of the part to approve, e.g. "Part A" for a brief; shown from that heading to the next at its level.',
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

interface ReviewItem {
  target: ResolvedArtifactPath;
  label: string;
  section?: string;
}

/**
 * What the review shows of a file: its front matter folded into one line (the
 * case's check, inputs and approval, not the fields themselves), and with a
 * `section`, only that heading's part.
 */
export function reviewSource(source: string, section?: string): string {
  let text = source;
  let summary: string | undefined;
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (front) {
    text = text.slice(front[0].length);
    const field = (name: string) =>
      new RegExp(`^${name}:[ \\t]*(.*)$`, "m").exec(front[1]!)?.[1]?.trim();
    const inputs = [...front[1]!.matchAll(/^\s*-\s*name:\s*(.+)$/gm)].map((m) =>
      m[1]!.trim(),
    );
    const by = field("approved_by");
    const parts = [
      field("check") ? `check: ${field("check")}` : undefined,
      inputs.length ? `inputs: ${inputs.join(", ")}` : undefined,
      by
        ? `approved by ${by}${field("approved_at") ? ` on ${field("approved_at")}` : ""}`
        : "not yet approved",
    ].filter(Boolean);
    summary = `_${parts.join(" · ")}_`;
  }
  if (section?.trim()) {
    const lines = text.split("\n");
    const wanted = section.trim().toLowerCase();
    // A `#` line inside a fenced code block isn't a heading.
    let fenced = false;
    const levels = lines.map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      return !fenced && /^#{1,6}\s/.test(line)
        ? /^#+/.exec(line)![0].length
        : 0;
    });
    const heading = (line: string) =>
      line
        .replace(/^#+\s*/, "")
        .replace(/\s+#*\s*$/, "")
        .trim()
        .toLowerCase();
    // An exact heading first, so "Part A" isn't taken from "Part A overview" above it.
    const exact = lines.findIndex(
      (line, i) => levels[i]! > 0 && heading(line) === wanted,
    );
    const start =
      exact >= 0
        ? exact
        : lines.findIndex(
            (line, i) => levels[i]! > 0 && heading(line).includes(wanted),
          );
    if (start >= 0) {
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i += 1) {
        if (levels[i]! > 0 && levels[i]! <= levels[start]!) {
          end = i;
          break;
        }
      }
      text = lines.slice(start, end).join("\n");
    } else {
      text = `_No heading "${section.trim()}" in this file, so all of it is shown._\n\n${text}`;
    }
  }
  return summary ? `${summary}\n\n${text}` : text;
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

/** The RPC review: per file, a select and an optional comment. */
async function reviewOverDialogs(
  documents: readonly ReviewDocument[],
  ui: ExtensionUIContext,
  dialog: ExtensionUIDialogOptions,
): Promise<ArtifactReview[] | null> {
  const reviews: ArtifactReview[] = [];
  for (const item of documents) {
    // An RPC client renders only what the dialog carries, so the file goes in it.
    const choice = await ui.select(
      `${item.label} (${item.path})\n\n${item.content}`,
      ["Approve", "Request changes", "Skip"],
      dialog,
    );
    if (choice === undefined) return null;
    if (choice === "Skip") {
      reviews.push({
        path: item.path,
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
      path: item.path,
      decision: choice === "Approve" ? "approved" : "changes_requested",
      opened: true,
      ...(comment ? { comment } : {}),
    });
  }
  return reviews;
}

/** Each file as the review shows it, read once when the review opens. */
function reviewDocuments(items: readonly ReviewItem[]): ReviewDocument[] {
  return items.map((item) => {
    let content: string;
    try {
      content = reviewSource(
        readFileSync(item.target.absolutePath, "utf8"),
        item.section,
      );
    } catch {
      content = "_This file doesn't exist._";
    }
    return { path: item.target.relativePath, label: item.label, content };
  });
}

function answered(reviews: ArtifactReview[] | null): AskUserOutcome {
  return reviews
    ? { type: "answered", answer: formatReviews(reviews) }
    : { type: "declined" };
}

/** Build the tool over a session's viewer. */
export function createReviewArtifactsTool(
  env?: NodeJS.ProcessEnv,
  /** Called before the terminal review opens, so an open artifact panel doesn't cover it. */
  beforeReview?: () => void,
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
        return {
          target,
          label: item.label?.trim() || target.relativePath,
          ...(item.section?.trim() ? { section: item.section.trim() } : {}),
        };
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
              ...(item.section ? { section: item.section } : {}),
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
                ? (beforeReview?.(),
                  await showReviewTui(
                    params.title,
                    reviewDocuments(items),
                    ui,
                    signal,
                  ))
                : await reviewOverDialogs(reviewDocuments(items), ui, dialog),
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

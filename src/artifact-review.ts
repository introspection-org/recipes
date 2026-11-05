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
import { createHash } from "node:crypto";
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

/**
 * At most this many bytes of shown content across one review's interrupt, which
 * a pause/resume host stores with the task. Past it, an item's content is cut
 * and marked `truncated`, and the host must not let it be approved.
 */
const MAX_REVIEW_INTERRUPT_BYTES = 256 * 1024;

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

/** A file as the review shows it, with the hash of the whole file (null when it doesn't exist). */
interface ShownDocument extends ReviewDocument {
  sha256: string | null;
}

/** Each file as the review shows it, read once when the review opens. */
function reviewDocuments(items: readonly ReviewItem[]): ShownDocument[] {
  return items.map((item) => {
    let content: string;
    let sha256: string | null = null;
    try {
      const bytes = readFileSync(item.target.absolutePath);
      sha256 = createHash("sha256").update(bytes).digest("hex");
      content = reviewSource(bytes.toString("utf8"), item.section);
    } catch {
      content = "_This file doesn't exist._";
    }
    return {
      path: item.target.relativePath,
      label: item.label,
      content,
      sha256,
    };
  });
}

/** One item of a pause/resume host's interrupt: what the reviewer is shown, so the host needs no file access. */
export interface ReviewInterruptItem {
  path: string;
  label: string;
  section?: string;
  /** The file as the review shows it (`reviewSource`). */
  content: string;
  /** sha256 of the whole file on disk when asked; null when it doesn't exist. */
  sha256: string | null;
  /** What this session's last answered review of the path showed, when it differs. */
  previous_content?: string;
  /** The content was cut to the interrupt's size cap; the item can be read but not approved. */
  truncated?: true;
}

/** The history key for one review scope: a path, and the section of it shown. */
export function reviewScope(path: string, section: string | undefined): string {
  return `${path}\u0000${section ?? ""}`;
}

/**
 * The interrupt's items, holding at most `MAX_REVIEW_INTERRUPT_BYTES` of
 * content: every file's current content first, in reading order, then the
 * previous versions that fit whole in what's left. `previous` is keyed by
 * `reviewScope`, so a different section of the same file is never its previous
 * version.
 */
export function reviewInterruptItems(
  documents: readonly ShownDocument[],
  sections: readonly (string | undefined)[],
  previous: ReadonlyMap<string, string>,
  budget = MAX_REVIEW_INTERRUPT_BYTES,
): ReviewInterruptItem[] {
  let left = budget;
  const take = (text: string): { text: string; cut: boolean } => {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes <= left) {
      left -= bytes;
      return { text, cut: false };
    }
    const kept = Buffer.from(text, "utf8").subarray(0, Math.max(left, 0));
    left = 0;
    // A cut can split a multi-byte character; drop the partial one.
    return { text: kept.toString("utf8").replace(/\uFFFD$/, ""), cut: true };
  };
  const shown = documents.map((doc) => take(doc.content));
  return documents.map((doc, index) => {
    const section = sections[index];
    const before = previous.get(reviewScope(doc.path, section));
    // A previous version is only worth sending whole, and only in the space the current files left.
    const prior =
      before !== undefined &&
      before !== doc.content &&
      !shown[index]!.cut &&
      Buffer.byteLength(before, "utf8") <= left
        ? take(before)
        : undefined;
    return {
      path: doc.path,
      label: doc.label,
      ...(section ? { section } : {}),
      content: shown[index]!.text,
      sha256: doc.sha256,
      ...(prior && !prior.cut ? { previous_content: prior.text } : {}),
      ...(shown[index]!.cut ? { truncated: true as const } : {}),
    };
  });
}

function answered(reviews: ArtifactReview[] | null): AskUserOutcome {
  return reviews
    ? { type: "answered", answer: formatReviews(reviews) }
    : { type: "declined" };
}

/** Build the tool over a session's viewer. One tool per session, so its memory of what was shown is the session's. */
export function createReviewArtifactsTool(
  env?: NodeJS.ProcessEnv,
  /** Called before the terminal review opens, so an open artifact panel doesn't cover it. */
  beforeReview?: () => void,
): ToolDefinition {
  // What this session's last answered review of each path showed, for the next review's diff. In memory only:
  // a restarted session shows no diff rather than a stale one.
  const lastShown = new Map<string, string>();
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
      const documents = reviewDocuments(items);
      const result = await askUser(
        {
          reason: "review",
          message: params.title,
          metadata: {
            kind: REVIEW_ARTIFACTS_TOOL_NAME,
            items: reviewInterruptItems(
              documents,
              items.map((item) => item.section),
              lastShown,
            ),
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
                  await showReviewTui(params.title, documents, ui, signal))
                : await reviewOverDialogs(documents, ui, dialog),
            ),
        },
      );
      const reviews =
        result.outcome.type === "answered" && result.outcome.answer
          ? parseReviews(result.outcome.answer)
          : [];
      // Shown means answered here, or handed to a pause/resume host, which rewrites this result on resume
      // rather than running the tool again.
      if (
        result.outcome.type === "answered" ||
        result.outcome.type === "awaiting_user"
      ) {
        documents.forEach((doc, index) =>
          lastShown.set(
            reviewScope(doc.path, items[index]!.section),
            doc.content,
          ),
        );
      }
      const files = documents.map(({ path, sha256 }) => ({ path, sha256 }));
      return {
        content: result.content,
        details: { ...result.details, reviews, files },
      };
    },
  };
  return tool as unknown as ToolDefinition;
}

/** Whether the agent opted into the review. */
export function wantsArtifactReview(agentTools: readonly string[]): boolean {
  return agentTools.includes(REVIEW_ARTIFACTS_TOOL_NAME);
}

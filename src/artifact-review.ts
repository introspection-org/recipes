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

import { showReviewTui } from "./artifact-review-tui.js";
import {
  resolveArtifactPath,
  type ResolvedArtifactPath,
} from "./artifact-viewer.js";
import type { AskUserOutcome } from "./interaction-text.js";
import { askUser } from "./interactions.js";
import {
  formatReviews,
  MAX_REVIEW_ITEMS,
  parseReviews,
  REVIEW_ARTIFACTS_TOOL_NAME,
  reviewInterruptItems,
  reviewScope,
  reviewSource,
  type ArtifactReview,
  type ReviewDocument,
  type ShownDocument,
} from "./review.js";

export {
  formatReviews,
  parseReviews,
  REVIEW_ARTIFACTS_TOOL_NAME,
  reviewInterruptItems,
  reviewScope,
  reviewSource,
  type ArtifactReview,
} from "./review.js";

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

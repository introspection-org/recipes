/**
 * The review of the files an agent wrote, as every renderer shares it: the
 * decisions, the answer text a run resumes with, the interrupt a pause/resume
 * host renders, each tab's name and the diff since the last review, plus the
 * interaction wording. Pi's terminal (`./artifact-review-tui.ts`) and a
 * browser host both import it, so it imports nothing from Node, Pi or a
 * renderer; `test/review-core.test.ts` fails if it does.
 */

export {
  DISMISSED_TEXT,
  formatInteractionOutcome,
  formatInteractionResume,
  type AskUserOutcome,
  type InteractionResumeResponse,
} from "./interaction-text.js";

export const REVIEW_ARTIFACTS_TOOL_NAME = "review_artifacts";

/** At most this many files in one review, so the user can get through it. */
export const MAX_REVIEW_ITEMS = 20;

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

/** One file as the review shows it. */
export interface ReviewDocument {
  /** The file's path, relative to the workspace. */
  path: string;
  label: string;
  /** What the box shows: the file's summary line and its section. */
  content: string;
}

/** A file as the review shows it, with the hash of the whole file (null when it doesn't exist). */
export interface ShownDocument extends ReviewDocument {
  sha256: string | null;
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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
    const bytes = encoder.encode(text);
    if (bytes.length <= left) {
      left -= bytes.length;
      return { text, cut: false };
    }
    const kept = bytes.subarray(0, Math.max(left, 0));
    left = 0;
    // A cut can split a multi-byte character; drop the partial one.
    return { text: decoder.decode(kept).replace(/�$/, ""), cut: true };
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
      encoder.encode(before).length <= left
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

/** A case-like id at the start of a name: `C1`, `C1-1`, `C4/C5`. */
const TAB_ID = /^([A-Za-z]{1,3}\d+(?:[-/][A-Za-z]{0,3}\d+)*)(?![A-Za-z0-9])/;

/**
 * A tab's name: an id at the start of the label ("C1" from "C1: four
 * questions"), else at the start of the file's name ("C1-1" from
 * `outputs/C1-1-transcript.md`), else the file's name when short (`DESIGN`),
 * else the tab's number.
 */
export function tabName(label: string, path: string, index: number): string {
  const name = path.replace(/\/+$/, "").split("/").pop() ?? "";
  const stem = name.replace(/\.[^.]*$/, "");
  const id = TAB_ID.exec(label.trim())?.[1] ?? TAB_ID.exec(stem)?.[1];
  if (id) return id;
  return stem.length > 0 && stem.length <= 12 ? stem : String(index + 1);
}

/** One line of a diff between what the reviewer saw last time and now. */
export interface DiffLine {
  kind: "same" | "added" | "removed";
  text: string;
}

/** The most cells the changed middle's table may hold before the diff falls back. */
export const LINE_DIFF_MAX_CELLS = 1_000_000;

/**
 * A line diff of a file's previous review (`previous_content`) against now:
 * the common prefix and suffix are kept as they are, and the changed middle
 * is diffed by longest common subsequence. A middle whose table would exceed
 * `LINE_DIFF_MAX_CELLS` reads as removed and then added, so memory stays
 * bounded whatever the input.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start])
    start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const lines: DiffLine[] = a
    .slice(0, start)
    .map((text) => ({ kind: "same", text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const width = midB.length + 1;
  if ((midA.length + 1) * width > LINE_DIFF_MAX_CELLS) {
    for (const text of midA) lines.push({ kind: "removed", text });
    for (const text of midB) lines.push({ kind: "added", text });
  } else {
    const lengths = new Uint32Array((midA.length + 1) * width);
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        lengths[i * width + j] =
          midA[i] === midB[j]
            ? lengths[(i + 1) * width + j + 1]! + 1
            : Math.max(
                lengths[(i + 1) * width + j]!,
                lengths[i * width + j + 1]!,
              );
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        lines.push({ kind: "same", text: midA[i]! });
        i += 1;
        j += 1;
      } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) {
        lines.push({ kind: "removed", text: midA[i]! });
        i += 1;
      } else {
        lines.push({ kind: "added", text: midB[j]! });
        j += 1;
      }
    }
    for (; i < midA.length; i += 1)
      lines.push({ kind: "removed", text: midA[i]! });
    for (; j < midB.length; j += 1)
      lines.push({ kind: "added", text: midB[j]! });
  }
  for (const text of a.slice(endA)) lines.push({ kind: "same", text });
  return lines;
}

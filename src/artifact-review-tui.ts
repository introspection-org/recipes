/**
 * The terminal review: inline in place of the editor, a tab per file (and a
 * Submit tab) when there are several, the file in a capped box that scrolls,
 * and the choices under it.
 *
 * It owns no file access and no review logic. `./artifact-review.ts` reads
 * each file and its section and hands over what to show, and the decisions and
 * tab names come from `./review.ts`; this only draws and handles keys.
 */

import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";

import {
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { artifactMarkdownTheme } from "./artifact-viewer-tui.js";
import {
  type ArtifactPanelScrollBy,
  PASTE_END,
  PASTE_START,
  panelScrollFor,
  printable,
  withoutLastCharacter,
} from "./interaction-tui.js";
import {
  tabName,
  tabWindow,
  type ArtifactReview,
  type ReviewDecision,
  type ReviewDocument,
} from "./review.js";

export { tabName } from "./review.js";

/** The most rows the file's box takes; a longer file scrolls in it. */
const REVIEW_BOX_MAX_ROWS = 20;
/** The most rows the Submit summary shows; a longer one scrolls. */
const REVIEW_SUMMARY_MAX_ROWS = 5;

interface ReviewState {
  decision?: Exclude<ReviewDecision, "not_reviewed">;
  comment?: string;
}

/**
 * The terminal review, inline in place of the editor: a tab per file (and a
 * Submit tab) when there are several, the file itself in a box, and Approve,
 * Approve with a comment or Request changes under it. Resolves with one review per file, or null when the
 * user dismisses it.
 */
export function showReviewTui(
  title: string,
  items: readonly ReviewDocument[],
  ui: ExtensionUIContext,
  signal: AbortSignal | undefined,
): Promise<ArtifactReview[] | null> {
  return ui.custom<ArtifactReview[] | null>(
    (tui, theme: Theme, _keybindings, done) => {
      const states: ReviewState[] = items.map(() => ({}));
      const opened = new Set<number>([0]);
      const scrolls = [...items.map(() => 0), 0];
      const documents = new Map<number, Markdown>();
      const several = items.length > 1;
      // The Submit tab sits after the files.
      let active = 0;
      let option = 0;
      let commenting = false;
      let commentDecision: Exclude<ReviewDecision, "not_reviewed"> =
        "changes_requested";
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
            path: item.path,
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
          : ["Approve", "Approve with a comment", "Request changes"];
      const choose = (index: number) => {
        if (onSubmitTab()) {
          if (index === 1)
            for (const state of states)
              if (!state.decision) state.decision = "approved";
          finish(results());
        } else if (index === 0) decide("approved");
        else {
          commenting = true;
          commentDecision = index === 1 ? "approved" : "changes_requested";
          draft = states[active]!.comment ?? "";
          refresh();
        }
      };
      const document = (index: number): Markdown => {
        let markdown = documents.get(index);
        if (!markdown) {
          markdown = new Markdown(
            items[index]!.content,
            0,
            0,
            artifactMarkdownTheme(theme),
          );
          documents.set(index, markdown);
        }
        return markdown;
      };
      const scroll = (by: ArtifactPanelScrollBy) => {
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
            const texts = [
              ...items.map(
                (item, index) =>
                  ` ${mark(index)} ${tabName(item.label, item.path, index)} `,
              ),
              ` ✔ Submit `,
            ];
            const styled = texts.map((text, index) =>
              index === active
                ? theme.inverse(theme.fg("accent", text))
                : index === items.length
                  ? theme.fg("dim", text)
                  : theme.fg(
                      states[index]!.decision ? "success" : "text",
                      text,
                    ),
            );
            const lead = ` ${title}  `;
            // The tabs slide to keep the current one in view; ‹ › mark hidden ones.
            const { start, end } = tabWindow(
              texts.map((text) => visibleWidth(text) + 1),
              active,
              Math.max(10, width - visibleWidth(lead)),
            );
            add(
              lead +
                (start > 0 ? theme.fg("dim", "‹ ") : "") +
                styled.slice(start, end).join(" ") +
                (end < texts.length ? theme.fg("dim", " ›") : ""),
            );
          } else add(` ${theme.bold(title)}`);
          add();
          const inner = Math.max(10, width - 4);
          const border = (text: string) => theme.fg("dim", text);
          let body: string[];
          // Both the file and the Submit summary scroll; the summary keeps its position in the slot after the files.
          const scrollable = true;
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
              theme.bold(` ${item.label}`) + theme.fg("dim", `  ${item.path}`),
            );
            body = document(active).render(inner);
          }
          const rows = tui.terminal?.rows ?? 24;
          // At most half the terminal, so the conversation above stays in view.
          lastBodyHeight = Math.max(
            4,
            Math.min(
              body.length,
              onSubmitTab() ? REVIEW_SUMMARY_MAX_ROWS : REVIEW_BOX_MAX_ROWS,
              Math.floor(rows / 2),
            ),
          );
          lastMaxScroll = scrollable
            ? Math.max(0, body.length - lastBodyHeight)
            : 0;
          const top = Math.min(scrolls[active]!, lastMaxScroll);
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
              ` ${theme.fg("text", commentDecision === "approved" ? "Comment: " : "What should change? ")}${theme.fg("accent", `${draft}█`)}`,
            );
            add(
              theme.fg(
                "dim",
                draft.trim() || commentDecision === "approved"
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
            lastMaxScroll > 0 ? "j/k scroll" : undefined,
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
              if (!comment && commentDecision === "changes_requested") return;
              commenting = false;
              draft = "";
              decide(commentDecision, comment || undefined);
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
          const by =
            panelScrollFor(data) ??
            (data === "j"
              ? "line-down"
              : data === "k"
                ? "line-up"
                : matchesKey(data, Key.space)
                  ? "page-down"
                  : data === "b"
                    ? "page-up"
                    : undefined);
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

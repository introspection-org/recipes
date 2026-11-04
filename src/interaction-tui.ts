import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  Key,
  decodeKittyPrintable,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";

interface ChoiceOption {
  label: string;
  description?: string;
}

/**
 * What the choice list returns: the chosen option indexes, and either text
 * typed straight into the list (`typed`) or a request for the separate text
 * input (`custom`, Enter on the empty typed-answer row).
 */
export interface ChoiceTuiResult {
  selected: number[];
  typed?: string;
  custom?: boolean;
}

/** The multi-select list's result, kept for its existing callers. */
export type MultiSelectTuiResult = ChoiceTuiResult;

/**
 * A numbered choice list where typing answers straight away, as in other
 * coding tools: any printable key starts a typed answer on the last row, so
 * the owner never has to pick "something else" first. Digits pick (or, with
 * `multiple`, toggle) an option until something is typed. Esc clears a typed
 * answer, then dismisses the list (`null`).
 */
export function showChoiceTui(
  message: string,
  options: readonly ChoiceOption[],
  ui: ExtensionUIContext,
  signal: AbortSignal | undefined,
  settings: { multiple: boolean; typedLabel: string }
): Promise<ChoiceTuiResult | null> {
  const { multiple, typedLabel } = settings;
  return ui.custom<ChoiceTuiResult | null>(
    (tui, theme, _keybindings, done) => {
      const selected = new Set<number>();
      const typedIndex = options.length;
      const doneIndex = multiple ? options.length + 1 : -1;
      const itemCount = options.length + (multiple ? 2 : 1);
      let activeIndex = 0;
      let typed = "";
      let pasting = false;
      let settled = false;

      const finish = (result: ChoiceTuiResult | null) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", cancel);
        done(result);
      };
      const cancel = () => finish(null);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) queueMicrotask(cancel);

      const refresh = () => tui.requestRender();
      const toggle = (index: number) => {
        if (selected.has(index)) selected.delete(index);
        else selected.add(index);
        refresh();
      };
      const answer = (): ChoiceTuiResult => {
        const text = typed.trim();
        return text
          ? { selected: [...selected], typed: text }
          : { selected: [...selected] };
      };
      const type = (text: string) => {
        typed += text;
        activeIndex = typedIndex;
        refresh();
      };

      return {
        render(width: number): string[] {
          const lines: string[] = [];
          const add = (line: string) =>
            lines.push(truncateToWidth(line, width));
          const title = multiple ? " Select all that apply " : " Choose one ";
          add(
            theme.fg(
              "accent",
              `-${title}${"-".repeat(Math.max(0, width - title.length - 1))}`
            )
          );
          for (const line of wrapText(message, width - 2)) {
            add(` ${theme.fg("text", theme.bold(line))}`);
          }
          lines.push("");

          for (let index = 0; index < options.length; index += 1) {
            const option = options[index]!;
            const active = index === activeIndex;
            const prefix = active ? theme.fg("accent", " > ") : "   ";
            const marker = multiple
              ? `${selected.has(index) ? "[x]" : "[ ]"} `
              : "";
            // Titles only: a list of choices reads at a glance; the
            // question carries the context.
            const label = `${marker}${index + 1}. ${option.label}`;
            add(prefix + theme.fg(active ? "accent" : "text", label));
          }

          // The last row is an input: a placeholder until something is
          // typed, with a cursor while it's selected.
          const typedActive = activeIndex === typedIndex;
          const cursor = typedActive ? "█" : "";
          const typedRow = typed
            ? theme.fg("accent", `${typedIndex + 1}. ${typed}${cursor}`)
            : theme.fg(typedActive ? "accent" : "text", `${typedIndex + 1}. `) +
              theme.fg("dim", typedLabel) +
              theme.fg("accent", cursor);
          add((typedActive ? theme.fg("accent", " > ") : "   ") + typedRow);
          if (multiple) {
            const doneActive = activeIndex === doneIndex;
            add(
              (doneActive ? theme.fg("accent", " > ") : "   ") +
                theme.fg(
                  doneActive ? "accent" : "text",
                  `Done (${selected.size + (typed.trim() ? 1 : 0)})`
                )
            );
          }
          lines.push("");
          add(
            theme.fg(
              "dim",
              multiple
                ? " Up/Down move - Space toggle - type to answer - Enter action - Esc dismiss"
                : " Up/Down move - Enter choose - type to answer - Esc dismiss"
            )
          );
          add(theme.fg("accent", "-".repeat(width)));
          return lines;
        },
        invalidate() {},
        handleInput(data: string) {
          if (matchesKey(data, Key.up)) {
            activeIndex = (activeIndex - 1 + itemCount) % itemCount;
            refresh();
            return;
          }
          if (matchesKey(data, Key.down)) {
            activeIndex = (activeIndex + 1) % itemCount;
            refresh();
            return;
          }
          if (matchesKey(data, Key.escape)) {
            // A typed answer is cleared first, so Esc never loses the list.
            if (typed) {
              typed = "";
              refresh();
            } else {
              finish(null);
            }
            return;
          }
          if (pasting || data.includes(PASTE_START)) {
            // A bracketed paste can arrive over several events: take its
            // text, markers removed and lines joined, until the end marker.
            pasting = !data.includes(PASTE_END);
            const text = data
              .replace(PASTE_START, "")
              .replace(PASTE_END, "")
              .replace(/\r\n|\r|\n|\t/g, " ")
              // eslint-disable-next-line no-control-regex
              .replace(/[\x00-\x1f\x7f]/g, "");
            const clean = printable(text);
            if (clean) type(clean);
            return;
          }
          if (matchesKey(data, Key.backspace)) {
            if (typed) {
              typed = withoutLastCharacter(typed);
              activeIndex = typedIndex;
              refresh();
            }
            return;
          }
          if (matchesKey(data, Key.enter)) {
            if (activeIndex < options.length) {
              if (multiple) toggle(activeIndex);
              else finish({ selected: [activeIndex] });
            } else if (activeIndex === typedIndex) {
              finish(
                typed.trim()
                  ? answer()
                  : { selected: [...selected], custom: true }
              );
            } else {
              finish(answer());
            }
            return;
          }
          // Until something is typed, digits pick and Space toggles; after
          // that every printable key, digits and spaces included, is text.
          if (!typed && data.length === 1 && data >= "1" && data <= "9") {
            const index = Number(data) - 1;
            if (index >= options.length) return;
            if (multiple) toggle(index);
            else finish({ selected: [index] });
            return;
          }
          if (!typed && multiple && matchesKey(data, Key.space)) {
            if (activeIndex < options.length) toggle(activeIndex);
            return;
          }
          const text = printable(data);
          if (text) type(text);
        },
        dispose() {
          signal?.removeEventListener("abort", cancel);
        },
      };
    }
  );
}

/** The multi-select list: [`showChoiceTui`] with toggles and a Done row. */
export function showMultiSelectTui(
  message: string,
  options: readonly ChoiceOption[],
  ui: ExtensionUIContext,
  signal: AbortSignal | undefined,
  customLabel = "Other"
): Promise<MultiSelectTuiResult | null> {
  return showChoiceTui(message, options, ui, signal, {
    multiple: true,
    typedLabel: customLabel,
  });
}

/** Bracketed-paste markers: terminals wrap pasted text in these. */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** `text` without its last user-visible character (grapheme cluster). */
export function withoutLastCharacter(text: string): string {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter) {
    const graphemes = [...new Segmenter(undefined, { granularity: "grapheme" }).segment(text)];
    return graphemes
      .slice(0, -1)
      .map((part) => part.segment)
      .join("");
  }
  return Array.from(text).slice(0, -1).join("");
}

/**
 * The text a keypress or paste adds: one printable key (also as a Kitty
 * CSI-u sequence), or pasted text without control characters.
 */
function printable(data: string): string | undefined {
  if (isKeyRelease(data)) return undefined;
  const key = decodeKittyPrintable(data);
  if (key) return key;
  // eslint-disable-next-line no-control-regex
  return data.length > 0 && !/[\x00-\x1f\x7f]/.test(data) ? data : undefined;
}

function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && candidate.length > Math.max(10, width)) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

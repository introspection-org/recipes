import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

interface MultiSelectOption {
  label: string;
  description?: string;
}

export interface MultiSelectTuiResult {
  selected: number[];
  custom?: boolean;
}

export function showMultiSelectTui(
  message: string,
  options: readonly MultiSelectOption[],
  ui: ExtensionUIContext,
  signal: AbortSignal | undefined,
  customLabel = "Other"
): Promise<MultiSelectTuiResult | null> {
  return ui.custom<MultiSelectTuiResult | null>(
    (tui, theme, _keybindings, done) => {
      const selected = new Set<number>();
      const customIndex = options.length;
      const doneIndex = options.length + 1;
      const itemCount = options.length + 2;
      let activeIndex = 0;
      let settled = false;

      const finish = (result: MultiSelectTuiResult | null) => {
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

      return {
        render(width: number): string[] {
          const lines: string[] = [];
          const add = (line: string) =>
            lines.push(truncateToWidth(line, width));
          const title = " Select all that apply ";
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
            const option = options[index];
            const active = index === activeIndex;
            const prefix = active ? theme.fg("accent", " > ") : "   ";
            const marker = selected.has(index) ? "[x]" : "[ ]";
            const label = `${marker} ${index + 1}. ${option.label}`;
            add(prefix + theme.fg(active ? "accent" : "text", label));
            for (const line of wrapText(option.description ?? "", width - 8)) {
              add(`       ${theme.fg("muted", line)}`);
            }
          }

          const customActive = activeIndex === customIndex;
          add(
            (customActive ? theme.fg("accent", " > ") : "   ") +
              theme.fg(customActive ? "accent" : "muted", customLabel)
          );
          const doneActive = activeIndex === doneIndex;
          add(
            (doneActive ? theme.fg("accent", " > ") : "   ") +
              theme.fg(
                doneActive ? "accent" : "text",
                `Done (${selected.size})`
              )
          );
          lines.push("");
          add(
            theme.fg(
              "dim",
              " Up/Down move - Space toggle - Enter action - Esc dismiss"
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
          if (data.length === 1 && data >= "1" && data <= "9") {
            const index = Number(data) - 1;
            if (index < options.length) toggle(index);
            return;
          }
          if (matchesKey(data, Key.space)) {
            if (activeIndex < options.length) toggle(activeIndex);
            return;
          }
          if (matchesKey(data, Key.enter)) {
            if (activeIndex < options.length) {
              toggle(activeIndex);
            } else if (activeIndex === customIndex) {
              finish({ selected: [...selected], custom: true });
            } else {
              finish({ selected: [...selected] });
            }
            return;
          }
          if (matchesKey(data, Key.escape)) finish(null);
        },
        dispose() {
          signal?.removeEventListener("abort", cancel);
        },
      };
    }
  );
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

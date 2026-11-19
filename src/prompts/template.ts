const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export class TemplateError extends Error {
  override name = "TemplateError";
}

/** The placeholders a template names, in order of first use. */
export function templatePlaceholders(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

/**
 * Fill a template's `{{ name }}` placeholders from `slots`. Nothing else is
 * syntax: no loops, conditionals or filters. A placeholder with no slot is an
 * error. A block (text between blank lines) whose placeholders all render
 * empty is dropped, so a section and its heading disappear together without a
 * conditional. Slot text is inserted as given: escaping is the builder's.
 */
export function renderTemplate(
  template: string,
  slots: Readonly<Record<string, string>>,
): string {
  for (const name of templatePlaceholders(template)) {
    if (!(name in slots)) {
      throw new TemplateError(
        `template names {{ ${name} }}, which no slot fills`,
      );
    }
  }
  const blocks = template.split(/\n\n/);
  return blocks
    .filter((block) => {
      const names = templatePlaceholders(block);
      return names.length === 0 || names.some((name) => slots[name] !== "");
    })
    .map((block) =>
      block.replace(PLACEHOLDER, (_, name: string) => slots[name]!),
    )
    .join("\n\n");
}

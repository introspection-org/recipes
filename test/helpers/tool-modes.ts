import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import googleProductivityModule from "../../packages/productivity/google/src/index.js";
import { writeFixtureRecipe } from "../../src/test-utils.js";

const PACKAGE = "@acme/in-memory-google";

// `read` in every mode, so each is offered the productivity skill.
const GOOGLE = "read, mail, calendar, drive";

/** The agent's `tools` block per first-party tool mode measured. */
export const TOOL_MODES = {
  tools: [`include: [${GOOGLE}]`],
  "tools-deferred": [`include: [${GOOGLE}]`, 'defer: ["*"]'],
  codemode: [`include: [${GOOGLE}]`, "mode: codemode"],
  // The tools reach the model as bash's `tools` command.
  cli: [`include: [bash, ${GOOGLE}]`, "mode: cli"],
} as const satisfies Record<string, readonly string[]>;

export type ToolMode = keyof typeof TOOL_MODES;

/**
 * A Recipe whose agent has Google's `mail`, `calendar` and `drive` in `mode`.
 * Its provider package is the real Google descriptor, so the tools the model
 * sees are Google's, over the in-memory session in `in-memory-google.ts`, so
 * no call reaches Google.
 */
export function googleToolModeRecipe(mode: ToolMode) {
  const fixture = writeFixtureRecipe({
    toolsBlock: ["tools:", ...TOOL_MODES[mode].map((line) => `  ${line}`)],
    dependencies: { [PACKAGE]: "1.0.0" },
    manifestPi: { productivity: [{ provider: "google", package: PACKAGE }] },
  });
  const write = (path: string, body: string) => {
    const full = join(fixture.recipeDir, "node_modules", PACKAGE, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  };
  write(
    "package.json",
    JSON.stringify({
      name: PACKAGE,
      version: "1.0.0",
      type: "module",
      main: "index.js",
    }),
  );
  const { kind, apiVersion, provider, capabilities } = googleProductivityModule;
  write(
    "index.js",
    [
      `import { createInMemoryGoogleSession } from ${JSON.stringify(join(import.meta.dirname, "in-memory-google.ts"))};`,
      `export default { kind: ${JSON.stringify(kind)}, apiVersion: ${apiVersion}, provider: ${JSON.stringify(provider)},`,
      `  capabilities: ${JSON.stringify(capabilities)},`,
      "  createSession: () => createInMemoryGoogleSession() };",
      "",
    ].join("\n"),
  );
  return fixture;
}

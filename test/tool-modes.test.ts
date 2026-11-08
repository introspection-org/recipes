import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { type RecipeSessionHandle } from "../src/session.js";
import { modelView, openRecipeSession } from "./helpers/mcp-session.js";
import { RECORDING } from "./helpers/polly.js";
import {
  googleToolModeRecipe,
  TOOL_MODES,
  type ToolMode,
} from "./helpers/tool-modes.js";

/**
 * What each first-party tool mode hands the model on its first turn, on the
 * faux model: the bytes of the system prompt and of the declared tools for
 * Google's `mail`, `calendar` and `drive`. The model-free baseline beside the
 * token counts `tool-modes.recording.test.ts` records; written beside those
 * when recording.
 */
const DIR = join(import.meta.dirname, "recordings", "tool-modes");

interface FirstTurn {
  systemPromptBytes: number;
  toolsBytes: number;
  tools: string[];
}

describe("first-party tool modes, first turn (faux model)", () => {
  const handles: RecipeSessionHandle[] = [];
  const cleanups: Array<() => void> = [];
  afterEach(async () => {
    for (const handle of handles.splice(0))
      await handle.dispose().catch(() => {});
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  async function firstTurn(mode: ToolMode): Promise<FirstTurn> {
    const fixture = googleToolModeRecipe(mode);
    cleanups.push(fixture.cleanup);
    let turn: FirstTurn | undefined;
    const handle = await openRecipeSession({
      ...fixture,
      bindings: [],
      responses: [
        (context) => {
          const { prompt, tools } = modelView(context);
          turn = {
            systemPromptBytes: Buffer.byteLength(prompt),
            toolsBytes: Buffer.byteLength(JSON.stringify(tools)),
            tools: tools.map((tool) => tool.name).sort(),
          };
          return fauxAssistantMessage("done");
        },
      ],
    });
    handles.push(handle);
    await handle.session.prompt("go");
    return turn!;
  }

  it("declares the three tools, tool_search, codemode, or bash", async () => {
    const turns = {} as Record<ToolMode, FirstTurn>;
    for (const mode of Object.keys(TOOL_MODES) as ToolMode[])
      turns[mode] = await firstTurn(mode);
    console.table(
      Object.fromEntries(
        Object.entries(turns).map(([mode, turn]) => [
          mode,
          {
            systemPromptBytes: turn.systemPromptBytes,
            toolsBytes: turn.toolsBytes,
            tools: turn.tools.join(" "),
          },
        ]),
      ),
    );
    if (RECORDING) {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(
        join(DIR, "faux-baseline.json"),
        `${JSON.stringify(turns, null, 2)}\n`,
      );
    }

    expect(turns.tools.tools).toEqual(["calendar", "drive", "mail", "read"]);
    expect(turns["tools-deferred"].tools).toContain("tool_search");
    expect(turns["tools-deferred"].tools).not.toContain("mail");
    expect(turns.codemode.tools).toContain("codemode");
    expect(turns.codemode.tools).not.toContain("mail");
    expect(turns.cli.tools).toEqual(["bash", "read"]);
    expect(turns["tools-deferred"].toolsBytes).toBeLessThan(
      turns.tools.toolsBytes,
    );
    expect(turns.codemode.toolsBytes).toBeLessThan(turns.tools.toolsBytes);
  });
});

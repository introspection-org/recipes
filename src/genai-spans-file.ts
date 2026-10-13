import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { piSessionToSpans } from "@introspection-sdk/introspection-pi";

/** Path of the file a standalone Pi run keeps its GenAI span list in. */
export const GENAI_SPANS_FILE_ENV = "PI_RECIPE_GENAI_SPANS_FILE";

type SessionReader = Pick<
  ExtensionContext["sessionManager"],
  "getHeader" | "getEntries" | "getSessionId"
>;

/**
 * Write the session as the GenAI span list the platform's conversation export
 * returns: the spans `pi-session-spans` prints, without a second process.
 *
 * Rendered from the entries in memory, since Pi creates the session file only
 * once the model has answered. Replaced atomically, so a reader never sees a
 * partial list.
 */
export function writeGenAiSpansFile(path: string, session: SessionReader): void {
  const header = session.getHeader();
  if (!header) return;
  const content = [header, ...session.getEntries()].map((entry) => JSON.stringify(entry)).join("\n");
  const spans = piSessionToSpans(content, session.getSessionId());
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.tmp`;
  writeFileSync(partial, `${JSON.stringify(spans)}\n`);
  renameSync(partial, path);
}

/**
 * Keep the file named by `PI_RECIPE_GENAI_SPANS_FILE` current for the session.
 *
 * Written when the session starts and after every turn, not only when the run
 * ends: a run that is killed on a timeout still leaves the turns it finished,
 * and a resumed one never leaves the file of an earlier session behind.
 */
export function registerGenAiSpansFile(pi: ExtensionAPI, env: NodeJS.ProcessEnv): void {
  const path = env[GENAI_SPANS_FILE_ENV]?.trim();
  if (!path) return;
  const write = (_event: unknown, ctx: ExtensionContext) => {
    try {
      writeGenAiSpansFile(path, ctx.sessionManager);
    } catch (error) {
      // An observer of the run: it must not end the run it describes.
      process.stderr.write(`${GENAI_SPANS_FILE_ENV}: ${(error as Error).message}\n`);
    }
  };
  pi.on("session_start", write);
  pi.on("turn_end", write);
  pi.on("agent_end", write);
}

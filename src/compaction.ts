import {
  compact,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { RecipeAgentSessionConfig } from "./recipe/session.js";

/**
 * Gives every compaction `session.compaction.instructions`. Pi's
 * `session_before_compact` cannot change the instructions its own summarizer
 * gets, and automatic compaction passes none, so this summarizes the prepared
 * cut itself with Pi's `compact`, through the session's stream function, which
 * resolves auth and routing as a session request does.
 */
export function compactionExtensions(
  config: RecipeAgentSessionConfig | undefined,
  session: () => AgentSession | undefined,
): ExtensionFactory[] {
  const instructions = config?.compactionInstructions;
  if (!instructions) return [];
  return [
    (pi) => {
      pi.on("session_before_compact", async (event, ctx) => {
        const current = session();
        if (!current || !ctx.model) return undefined;
        const compaction = await compact(
          event.preparation,
          ctx.model,
          undefined,
          undefined,
          event.customInstructions
            ? `${instructions}\n\n${event.customInstructions}`
            : instructions,
          event.signal,
          ctx.thinkingLevel,
          current.agent.streamFunction,
          undefined,
          current.settingsManager.getRetrySettings(),
        );
        return { compaction };
      });
    },
  ];
}

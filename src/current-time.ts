import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const CURRENT_TIME_TOOL_NAME = "current-time";
export const CURRENT_TIME_ENV = "RECIPES_CURRENT_TIME";

const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Resolve live UTC, or a frozen ISO 8601 UTC timestamp from the host. */
export function currentTimeUtc(now?: string): string {
  if (now == null || now === "") return new Date().toISOString();
  if (!UTC_ISO.test(now) || !Number.isFinite(Date.parse(now))) {
    throw new Error(
      `${CURRENT_TIME_ENV} must be an ISO 8601 UTC timestamp: ${now}`
    );
  }
  return new Date(now).toISOString();
}

/** Host `current-time` tool. Agents opt in with `tools: [current-time]`. */
export function createCurrentTimeTool(
  env: NodeJS.ProcessEnv = process.env
): ToolDefinition {
  const tool = defineTool({
    name: CURRENT_TIME_TOOL_NAME,
    label: CURRENT_TIME_TOOL_NAME,
    description: "Return the current time in UTC as an ISO 8601 timestamp.",
    parameters: Type.Object({}),
    async execute() {
      const text = currentTimeUtc(env[CURRENT_TIME_ENV]);
      return {
        content: [{ type: "text", text }],
        details: { utc: text },
      };
    },
  });
  Object.assign(tool, {
    promptSnippet: "Current time in UTC",
    promptGuidelines: ["Call current-time when you need the current UTC time."],
  });
  return tool;
}

import type { createMockExtensionAPI } from "./mock-extension.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Exercise a command through the actual single-tool dispatcher. */
export function channelCommand(pi: ReturnType<typeof createMockExtensionAPI>, command: string): {
  parameters: unknown;
  execute: (id: string, input: unknown, ...rest: unknown[]) => ReturnType<ToolDefinition["execute"]>;
} {
  const tool = pi.tools.get("channels")!;
  const parameters = tool.parameters as { anyOf?: Array<{ properties: { command: { const: string } } }> };
  return {
    ...tool,
    parameters: parameters.anyOf?.find((schema) => schema.properties.command.const === command),
    execute: (id: string, input: unknown, ...rest: unknown[]) =>
      tool.execute(id, { ...(input as object), command } as never, ...rest as [never, never, never]),
  };
}

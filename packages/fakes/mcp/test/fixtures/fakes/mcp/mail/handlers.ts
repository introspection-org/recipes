import { type McpServer, text, toolConfig } from "@introspection-ai/mcp-fakes";
import type { Contract } from "./contract.ts";
import tools from "./tools.json" with { type: "json" };

export interface State {
  now: string;
  emails: { to: string[]; subject: string }[];
}

const config = toolConfig<Contract>(tools);

export function register(server: McpServer, state: State) {
  server.registerTool("send-email", config("send-email"), async ({ to, subject }) => {
    state.emails.push({ to, subject });
    return text(`Sent email-${state.emails.length}`);
  });
}

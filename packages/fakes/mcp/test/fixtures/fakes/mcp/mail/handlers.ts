import { type McpServer, toolsOf } from "@introspection-ai/mcp-fakes";
import { contract } from "./contract.ts";

export interface State {
  now: string;
  emails: { to: string[]; subject: string }[];
}

const { config, answer } = toolsOf(contract);

export function register(server: McpServer, state: State) {
  server.registerTool("send-email", config("send-email"), async ({ to, subject }) => {
    state.emails.push({ to, subject });
    return answer("send-email", `Sent email-${state.emails.length}`);
  });
}

// A synthetic Recipe extension in the pattern the README documents: it
// registers the user agent's primitives with Pi's MCP client, codemode-exposed,
// and calls them from its own tool. Pi runs with `--tools say`, so the model
// never gets codemode and reaches the target only through `say`.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

// The text content of a primitive's result is its JSON object.
function json(outcome: any): any {
  if (outcome.isError) throw new Error(outcome.result.content[0].text);
  return JSON.parse(outcome.result.content[0].text);
}

export default function (pi: any) {
  pi.registerMcpServer("harbor", {
    // Pi refuses `${VAR}` in `url`, but expands it in `headers`.
    url: process.env.INTROSPECTION_USER_AGENT_URL!,
    headers: { Authorization: "Bearer ${INTROSPECTION_USER_AGENT_TOKEN}" },
    exposure: "codemode",
  });
  pi.registerTool({
    name: "say",
    label: "Say",
    description: "Send one message to the coding agent; returns its reply.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    async execute(_id: string, params: { text: string }, signal: AbortSignal, onUpdate: any, ctx: any) {
      let progress = 0;
      const { reply, exit_code } = json(
        await ctx.executeTool(
          "mcp__harbor__prompt_target",
          { prompt: [{ type: "text", text: params.text }] },
          {
            signal,
            onUpdate: (update: unknown) => {
              progress += 1;
              onUpdate?.(update);
            },
          },
        ),
      );
      const { logs_dir, inputs } = json(await ctx.executeTool("mcp__harbor__context", {}, { signal }));
      const entry = { tool: "say", text: params.text, reply, exit_code, progress, inputs };
      appendFileSync(join(logs_dir, "recipe-log.jsonl"), `${JSON.stringify(entry)}\n`);
      return { content: [{ type: "text", text: reply }], details: entry };
    },
  });
}

import type {
  ProductivityCallContext,
  ProductivityToolCallOutcome,
} from "@introspection-ai/recipes/productivity";

/** An MCP `CallToolResult`, as Pi hands it to a caller. */
interface FakeCallToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** A tool's handler: its result, or a thrown error, as Pi's MCP client would throw it. */
export type FakeTool = (args: Record<string, unknown>) => FakeCallToolResult;

export interface FakeToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * The session's tools as Pi's `ctx.executeTool` runs them: an MCP tool's
 * result comes back whole as `structuredContent`, an `isError` result as an
 * error outcome that keeps it, and a thrown error as an error outcome whose
 * only content is the message's text.
 */
export function fakeTools(tools: Record<string, FakeTool>): {
  ctx: ProductivityCallContext;
  calls: FakeToolCall[];
} {
  const calls: FakeToolCall[] = [];
  return {
    calls,
    ctx: {
      tools: {
        canCall: (name) => Object.hasOwn(tools, name),
        executeTool: async (
          name,
          args,
        ): Promise<ProductivityToolCallOutcome> => {
          calls.push({ name, arguments: args });
          const tool = tools[name];
          if (!tool)
            return {
              isError: true,
              content: [{ type: "text", text: `Tool ${name} not found` }],
            };
          try {
            const result = tool(args);
            return {
              isError: result.isError === true,
              content: result.content,
              structuredContent: result,
            };
          } catch (error) {
            return {
              isError: true,
              content: [{ type: "text", text: (error as Error).message }],
            };
          }
        },
      },
    },
  };
}

/** A tool answering with a structured result. */
export function structured(value: Record<string, unknown>): FakeTool {
  return () => ({
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value) }],
  });
}

/** A tool whose call Pi's MCP client fails with an HTTP status, in Pi's wording. */
export function httpFailure(status: number): FakeTool {
  return () => {
    throw new Error(
      status === 401
        ? "MCP server requires authentication"
        : `MCP HTTP request failed with status ${status}: {"error":{"code":${status}}}`,
    );
  };
}

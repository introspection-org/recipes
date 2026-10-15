// One JSON-RPC request to a fake, as an MCP client sends it; the SDK answers over SSE.
export async function rpc(url: string, method: string, params?: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  const text = await response.text();
  return JSON.parse(text.match(/^data: (.*)$/m)?.[1] ?? text);
}

export interface Called {
  text: string;
  isError: boolean;
  protocolError?: boolean;
  structuredContent?: unknown;
}

export async function callTool(url: string, name: string, args?: unknown): Promise<Called> {
  const body = await rpc(url, "tools/call", { name, arguments: args ?? {} });
  if (body.error) return { text: body.error.message, isError: true, protocolError: true };
  const text = body.result.content
    .filter((item: { type: string }) => item.type === "text")
    .map((item: { text: string }) => item.text)
    .join("\n");
  return {
    text,
    isError: body.result.isError === true,
    structuredContent: body.result.structuredContent,
  };
}

export const VALIDATION = (name: string) =>
  `Input validation error: Invalid arguments for tool ${name}: `;

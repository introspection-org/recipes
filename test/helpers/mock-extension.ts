import type {
  ExtensionEvent,
  ExtensionAPI,
  RegisteredCommand,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export interface MockExtensionAPI extends ExtensionAPI {
  commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
  tools: Map<string, ToolDefinition<any, any, any>>;
  flags: Map<string, { description?: string; type: "boolean" | "string"; default?: boolean | string }>;
  flagValues: Map<string, boolean | string>;
  handlers: Map<string, Array<(event: any, ctx: any) => unknown>>;
  messages: unknown[];
  entries: Array<{ customType: string; data?: unknown }>;
  sentMessages: Array<{ message: any; options?: any }>;
  messageRenderers: Map<string, (message: any, options: any, theme: any) => unknown>;
  sessionName?: string;
  activeTools: string[];
  thinkingLevel?: string;
  model?: unknown;
  emitExtensionEvent(event: ExtensionEvent, ctx: any): Promise<unknown[]>;
}

export function createMockExtensionAPI(): MockExtensionAPI {
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const tools = new Map<string, ToolDefinition<any, any, any>>();
  const flags = new Map<string, { description?: string; type: "boolean" | "string"; default?: boolean | string }>();
  const flagValues = new Map<string, boolean | string>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const messages: unknown[] = [];
  const entries: Array<{ customType: string; data?: unknown }> = [];
  const sentMessages: Array<{ message: any; options?: any }> = [];
  const messageRenderers = new Map<string, (message: any, options: any, theme: any) => unknown>();
  const api = {
    commands,
    tools,
    flags,
    flagValues,
    handlers,
    messages,
    entries,
    sentMessages,
    messageRenderers,
    activeTools: [],
    on(event: string, handler: (event: any, ctx: any) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool: ToolDefinition<any, any, any>) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) {
      commands.set(name, options);
    },
    registerShortcut() {},
    registerFlag(name: string, options: { description?: string; type: "boolean" | "string"; default?: boolean | string }) {
      flags.set(name, options);
      if (options.default !== undefined && !flagValues.has(name)) {
        flagValues.set(name, options.default);
      }
    },
    getFlag(name: string) {
      return flagValues.get(name);
    },
    registerMessageRenderer(customType: string, renderer: (message: any, options: any, theme: any) => unknown) {
      messageRenderers.set(customType, renderer);
    },
    sendMessage(message: unknown, options?: unknown) {
      messages.push(message);
      sentMessages.push({ message, options });
    },
    sendUserMessage() {},
    appendEntry(customType: string, data?: unknown) {
      entries.push({ customType, data });
    },
    setSessionName(name: string) {
      api.sessionName = name;
    },
    getSessionName() {
      return api.sessionName;
    },
    setActiveTools(toolNames: string[]) {
      api.activeTools = toolNames;
    },
    getActiveTools() {
      return api.activeTools;
    },
    getAllTools() {
      const builtins = ["read", "bash", "edit", "write"]
        .filter((name) => !tools.has(name))
        .map((name) => ({
          name,
          description: `${name} test tool`,
          parameters: {},
          exposure: "direct",
          sourceInfo: { path: `<builtin:${name}>`, source: "builtin", scope: "temporary", origin: "top-level" },
        }));
      return [...builtins, ...[...tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        exposure: tool.exposure ?? "direct",
        sourceInfo: { path: "<test>", source: "test", scope: "temporary", origin: "top-level" },
      }))];
    },
    setThinkingLevel(level: string) {
      api.thinkingLevel = level;
    },
    getThinkingLevel() {
      return api.thinkingLevel ?? "off";
    },
    async setModel(model: unknown) {
      api.model = model;
      return true;
    },
    async emitExtensionEvent(event: ExtensionEvent, ctx: any) {
      const results: unknown[] = [];
      let currentEvent = event;
      for (const handler of handlers.get(event.type) ?? []) {
        const result = await handler(currentEvent, ctx);
        results.push(result);
        if (
          currentEvent.type === "before_agent_start" &&
          result &&
          typeof result === "object" &&
          "systemPrompt" in result &&
          typeof result.systemPrompt === "string"
        ) {
          currentEvent = {
            ...currentEvent,
            systemPrompt: result.systemPrompt,
          };
        }
      }
      return results;
    },
    events: {
      emit() {},
      on() {
        return () => {};
      },
      off() {},
    },
  } as unknown as MockExtensionAPI;
  return api;
}

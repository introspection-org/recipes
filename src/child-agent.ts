import type { CredentialStore } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { autoResolveInteractions } from "./interactions.js";
import { createIsolatedChildSession } from "./child-session.js";
import {
  resolveRecipeCredentials,
  resolveRecipeModel,
} from "./model-binding.js";
import { applyRecipeAgentModelConfigToModel } from "./recipe/model.js";
import {
  type ResolvedRecipe,
} from "./recipe/resolve.js";
import type { RecipeSessionHandle } from "./session.js";

export interface CreateRecipeChildAgentRunnerOptions {
  /** Immutable Recipe graph shared with the root Pi session. */
  recipe: ResolvedRecipe;
  workspaceDir: string;
  agentName: string;
  env?: NodeJS.ProcessEnv;
  credentials?: CredentialStore;
  modelRegistry?: ModelRegistry;
  /** Observe the child's canonical Pi session events. */
  onEvent?: (event: AgentSessionEvent) => void;
  onAssistantMessage?: (text: string, stream: "delta" | "final") => void;
  onToolEvent?: (event: RecipeChildToolEvent) => void;
}

export interface RecipeChildAgentRunner {
  start(): Promise<void>;
  prompt(prompt: string): Promise<string>;
  steer(message: string): Promise<void>;
  cancel(): Promise<void>;
  shutdown(): Promise<void>;
}

export type CreateRecipeChildAgentRunner = (
  opts: CreateRecipeChildAgentRunnerOptions
) => RecipeChildAgentRunner;

export type RecipeChildToolEvent =
  | {
      type: "start";
      id: string;
      name: string;
      args: unknown;
    }
  | {
      type: "update";
      id: string;
      name: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "end";
      id: string;
      name: string;
      args: unknown;
      result: unknown;
      isError: boolean;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = asRecord(part);
      return record?.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function latestAssistantMessage(
  result: unknown
): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  const messages = Array.isArray(record.messages) ? record.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message) continue;
    if (!message.role || message.role === "assistant") return message;
  }
  return null;
}

/** Return a terminal provider/session failure that Pi recorded as a message. */
export function promptResultError(result: unknown): string | null {
  const message = latestAssistantMessage(result);
  const stopReason = message?.stopReason;
  if (stopReason !== "error" && stopReason !== "aborted") return null;
  const errorMessage = message?.errorMessage;
  if (typeof errorMessage === "string" && errorMessage.trim()) {
    return errorMessage.trim();
  }
  return stopReason === "aborted"
    ? "Child agent model request was aborted"
    : "Child agent model request failed";
}

export function promptResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const record = result as Record<string, unknown>;
  if (typeof record.output === "string") return record.output;
  const messages = Array.isArray(record.messages) ? record.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message) continue;
    if (message.role && message.role !== "assistant") continue;
    const text = contentText(message.content).trim();
    if (text) return text;
  }
  return "";
}

function messageFromEvent(event: AgentSessionEvent): Record<string, unknown> | null {
  const record = asRecord(event);
  const direct = asRecord(record?.message);
  if (direct) return direct;
  const assistantEvent = asRecord(record?.assistantMessageEvent);
  return asRecord(assistantEvent?.partial);
}

class RecipeChildAgentSessionRunner implements RecipeChildAgentRunner {
  private session: AgentSession | null = null;
  private handle: RecipeSessionHandle | null = null;
  private assistantStreamedText = false;

  constructor(private readonly opts: CreateRecipeChildAgentRunnerOptions) {}

  private emitAssistantText(text: string, stream: "delta" | "final"): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.opts.onAssistantMessage?.(trimmed, stream);
    if (stream === "delta") this.assistantStreamedText = true;
  }

  private handleSessionEvent(event: AgentSessionEvent): void {
    this.opts.onEvent?.(event);
    const record = asRecord(event);
    const message = messageFromEvent(event);
    const role = typeof message?.role === "string" ? message.role : undefined;

    if (record?.type === "tool_execution_start") {
      this.opts.onToolEvent?.({
        type: "start",
        id: String(record.toolCallId ?? ""),
        name: String(record.toolName ?? ""),
        args: record.args,
      });
      return;
    }

    if (record?.type === "tool_execution_update") {
      this.opts.onToolEvent?.({
        type: "update",
        id: String(record.toolCallId ?? ""),
        name: String(record.toolName ?? ""),
        args: record.args,
        partialResult: record.partialResult,
      });
      return;
    }

    if (record?.type === "tool_execution_end") {
      this.opts.onToolEvent?.({
        type: "end",
        id: String(record.toolCallId ?? ""),
        name: String(record.toolName ?? ""),
        args: record.args,
        result: record.result,
        isError: record.isError === true,
      });
      return;
    }

    if (record?.type === "message_start" && role === "assistant") {
      this.assistantStreamedText = false;
    }

    const assistantEvent = asRecord(record?.assistantMessageEvent);
    if (
      role === "assistant" &&
      record?.type === "message_update" &&
      assistantEvent?.type === "text_delta" &&
      typeof assistantEvent.delta === "string"
    ) {
      this.emitAssistantText(assistantEvent.delta, "delta");
      return;
    }

    if (
      role === "assistant" &&
      record?.type === "message_end" &&
      !this.assistantStreamedText
    ) {
      this.emitAssistantText(contentText(message?.content), "final");
    }
  }

  async start(): Promise<void> {
    if (this.session) return;

    const resolved = this.opts.recipe.selectAgent(this.opts.agentName);
    const model = applyRecipeAgentModelConfigToModel(
      resolveRecipeModel(resolved.modelSpec, this.opts.modelRegistry),
      resolved.modelConfig
    );
    const credentials = await resolveRecipeCredentials({
      provider: model.provider,
      env: this.opts.env ?? process.env,
      model,
      ...(this.opts.credentials
        ? { credentials: this.opts.credentials }
        : {}),
      ...(this.opts.modelRegistry
        ? { modelRegistry: this.opts.modelRegistry }
        : {}),
    });
    this.handle = await createIsolatedChildSession({
      recipe: this.opts.recipe,
      agentName: resolved.name,
      cwd: this.opts.workspaceDir,
      env: this.opts.env ?? process.env,
      credentials,
      credentialsResolved: true,
      modelOverride: model,
      onEvent: (event) => this.handleSessionEvent(event),
    });
    this.session = this.handle.session;
  }

  async prompt(prompt: string): Promise<string> {
    await this.start();
    if (!this.session) throw new Error("Background agent did not start");
    // Child sessions do not own the root session's interaction lifecycle.
    // Resolve their approval tools internally so they cannot open UI or emit
    // an interrupt that would strand the child waiting for the root user.
    await autoResolveInteractions(() => this.session!.prompt(prompt));
    const result = { messages: [...this.session.messages] };
    const error = promptResultError(result);
    if (error) throw new Error(error);
    return promptResultText(result);
  }

  async steer(message: string): Promise<void> {
    await this.start();
    if (!this.session) throw new Error("Background agent did not start");
    await this.session.steer(message);
  }

  async cancel(): Promise<void> {
    await this.session?.abort();
  }

  async shutdown(): Promise<void> {
    await this.handle?.dispose();
    this.handle = null;
    this.session = null;
  }
}

export function createRecipeChildAgentRunner(
  opts: CreateRecipeChildAgentRunnerOptions
): RecipeChildAgentRunner {
  return new RecipeChildAgentSessionRunner(opts);
}

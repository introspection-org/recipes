import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore, Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ResolvedRecipe } from "../recipe/resolve.js";
import type {
  MemoryContextOverride,
  MemoryContextSource,
} from "../memory.js";
import {
  createAgentSessionInternal,
  type CreateAgentSessionInternalOptions,
  type RecipeSessionHandle,
  type RecipeSessionOtelOptions,
} from "../session.js";

export interface CreateIsolatedChildSessionOptions {
  recipe: ResolvedRecipe;
  agentName: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  credentials?: CredentialStore;
  memory?: MemoryContextSource;
  memoryOverride?: MemoryContextOverride;
  credentialsResolved?: boolean;
  modelOverride?: Model<any>;
  otel?: RecipeSessionOtelOptions;
  onEvent?: (event: AgentSessionEvent) => void;
  sessionFactory?: (
    options: CreateAgentSessionInternalOptions
  ) => Promise<RecipeSessionHandle>;
}

/**
 * Shared child-session primitive used by both the embedded and interactive Pi
 * controllers. It owns the child's private MCP state and always disables
 * recursive delegation.
 */
export async function createIsolatedChildSession(
  opts: CreateIsolatedChildSessionOptions
): Promise<RecipeSessionHandle> {
  const mcpRuntimeDir = await mkdtemp(join(tmpdir(), "recipes-child-mcp-"));
  try {
    const handle = await (opts.sessionFactory ?? createAgentSessionInternal)({
      recipe: opts.recipe,
      agentName: opts.agentName,
      cwd: opts.cwd,
      env: { ...opts.env },
      ...(opts.credentials ? { credentials: opts.credentials } : {}),
      ...(opts.memory ? { memory: opts.memory } : {}),
      ...(opts.memoryOverride
        ? { memoryOverride: opts.memoryOverride }
        : {}),
      ...(opts.credentialsResolved ? { credentialsResolved: true } : {}),
      ...(opts.modelOverride ? { modelOverride: opts.modelOverride } : {}),
      ...(opts.otel ? { otel: opts.otel } : {}),
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      mcpRuntimeDir,
      runController: null,
      sessionRole: "subagent",
    });
    let disposed = false;
    return {
      ...handle,
      async dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        try {
          await handle.dispose();
        } finally {
          await rm(mcpRuntimeDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(mcpRuntimeDir, { recursive: true, force: true });
    throw error;
  }
}

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { RecipeConnectorModule } from "../connector-tools.js";
import { resolveChannelConfig } from "./config.js";
import type { ChannelConfig } from "./config.js";
import { ChannelRefStore } from "./refs.js";
import {
  CHANNEL_TOOL_IDS,
  channelConnectorTools,
  registerChannelTools,
  type ChannelToolId,
} from "./tools.js";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelTarget,
} from "./types.js";

export interface ChannelConnectorSession {
  readonly adapter: ChannelAdapter;
  /** Resolved lazily so a task with no channel origin still starts. */
  readonly target: ChannelTarget | (() => ChannelTarget);
  /** Optional tool-layer target policy, not a sandbox egress boundary. */
  readonly validateTarget?: (target: ChannelTarget, operation: ChannelToolId) => void | Promise<void>;
}

export interface ChannelConnectorModuleOptions {
  provider: string;
  /**
   * What this channel supports, as static data.
   *
   * Declared separately from `createSession` because the loader builds the tool
   * catalog before any session exists. A capability discovered by failing a
   * call would also waste an agent turn.
   */
  capabilities: ChannelCapabilities;
  /**
   * Resolve the default conversation and a client for one credential session.
   *
   * Called once per session. Return a lazy target for originless tasks so
   * explicit read/send calls can still use the credential session.
   */
  createSession(options: {
    config: ChannelConfig | null;
    env: NodeJS.ProcessEnv;
    cwd: string;
  }): ChannelConnectorSession;
}

const channelToolIds = new Set<string>(CHANNEL_TOOL_IDS);

/** Whether two capability descriptors say the same thing. */
function sameCapabilities(
  left: ChannelCapabilities,
  right: ChannelCapabilities,
): boolean {
  left = { ...left, targeting: left.targeting ?? false, list: left.list ?? false };
  right = { ...right, targeting: right.targeting ?? false, list: right.list ?? false };
  const keys = Object.keys(right) as (keyof ChannelCapabilities)[];
  return (
    Object.keys(left).length === keys.length &&
    keys.every((key) => left[key] === right[key])
  );
}

/**
 * Build a `RecipeConnectorModule` from a channel adapter.
 *
 * A provider package supplies transport plus a capability descriptor; the
 * neutral tool schemas, the opaque handles, and the capability filtering live
 * here. Two providers therefore cannot drift into differently-shaped versions
 * of the same operation. Targeting uses the common capability and schema,
 * not provider-defined arguments.
 *
 * The result satisfies the existing connector contract. The manifest selects
 * the provider package, the agent list selects tools from its catalog, and
 * `channels` is active immediately; the connector can restrict its commands.
 */
export function createChannelConnectorModule(
  options: ChannelConnectorModuleOptions,
): RecipeConnectorModule {
  const connectorTools = channelConnectorTools(options.capabilities);
  return {
    provider: options.provider,
    tools: connectorTools,
    createExtension(moduleOptions): ExtensionFactory {
      const unknown = moduleOptions.tools.filter(
        (tool) => tool !== "channels",
      );
      if (unknown.length > 0) {
        throw new Error(
          `Unknown ${options.provider} channel tool(s): ${unknown.join(", ")}`,
        );
      }
      const commands = moduleOptions.commands;
      const requireReply = moduleOptions.requireReply ?? (moduleOptions.tools.includes("channels") && commands?.length !== 0);
      if (requireReply && (!moduleOptions.tools.includes("channels") ||
          (commands !== undefined && !commands.includes("reply")))) {
        throw new Error("requireReply needs the channels tool with the reply command enabled");
      }
      if (commands?.some((command) => !channelToolIds.has(command))) {
        throw new Error("Unknown channels command in connector allowlist");
      }
      return (pi) => {
        if (!moduleOptions.tools.includes("channels")) return;
        const session = options.createSession({
          config: resolveChannelConfig(moduleOptions.env ?? process.env),
          env: moduleOptions.env ?? process.env,
          cwd: moduleOptions.cwd ?? process.cwd(),
        });
        if (session.adapter.provider !== options.provider) {
          throw new Error(
            `Channel adapter for '${options.provider}' returned provider '${session.adapter.provider}'`,
          );
        }
        if (!sameCapabilities(session.adapter.capabilities, options.capabilities)) {
          // The loader selected tools from the declared catalog. An adapter
          // with a different capability set would register a different tool
          // surface. Compare values so an adapter may rebuild the descriptor.
          throw new Error(
            `Channel adapter '${options.provider}' returned capabilities that differ from its declared catalog`,
          );
        }
        registerChannelTools(pi, session.adapter, {
          target: session.target,
          commands: commands as readonly ChannelToolId[] | undefined,
          requireReply,
          refs: new ChannelRefStore(),
          validateTarget: session.validateTarget,
        });
      };
    },
  };
}

import type {
  ProductivityCapabilities,
  ProductivitySession,
  ProductivitySessionOptions,
} from "./types.js";

/**
 * The productivity contract this host implements. A provider module declares
 * the version it was written against, and the host refuses one that differs;
 * bump it on any breaking change to `RecipeProductivityModule` or the session
 * interfaces in `types.ts`.
 */
export const PRODUCTIVITY_MODULE_API_VERSION = 1 as const;

/**
 * What a provider package exports as its default: a plain descriptor. The host
 * builds the `mail`, `calendar` and `drive` tools from `capabilities` and calls
 * `createSession` for one person's connection, so a provider package needs no
 * run-time import of `@introspection-ai/recipes`, only its types.
 */
export interface RecipeProductivityModule {
  readonly kind: "productivity";
  /** The contract version, `PRODUCTIVITY_MODULE_API_VERSION` when written. */
  readonly apiVersion: typeof PRODUCTIVITY_MODULE_API_VERSION;
  /** Served as `@introspection-ai/recipe-productivity-<provider>`. */
  readonly provider: string;
  /** Static, so the loader can build the tools before any session exists. */
  readonly capabilities: ProductivityCapabilities;
  /**
   * The transport for one person's connection. Called once per run, on the
   * first command, so a run that never uses the tools never needs a
   * connection.
   */
  createSession(
    options: ProductivitySessionOptions,
  ): ProductivitySession | Promise<ProductivitySession>;
}

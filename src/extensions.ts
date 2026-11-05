import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

export interface RecipeExtensionSessionContext {
  readonly recipe: {
    readonly name: string;
  };
  readonly agent: {
    readonly name: string;
  };
  readonly session: {
    readonly role: "root" | "subagent";
  };
  /**
   * The interpreter the host prepared for a direct dependency that declares
   * `pi.runtime.python`, by package name; `undefined` when that package
   * declares none or is not a direct dependency. Pass it to
   * `pythonExecutable({ python })` from `@introspection-ai/recipes/python`.
   */
  packagePython(name: string): string | undefined;
}

/** @internal Build the frozen context a host binds to its extensions. */
export function createRecipeExtensionSessionContext(options: {
  recipe: string;
  agent: string;
  role: "root" | "subagent";
  python?: Readonly<Record<string, { readonly interpreter: string }>>;
}): RecipeExtensionSessionContext {
  const python = options.python;
  return Object.freeze({
    recipe: Object.freeze({ name: options.recipe }),
    agent: Object.freeze({ name: options.agent }),
    session: Object.freeze({ role: options.role }),
    packagePython(name: string): string | undefined {
      return python && Object.hasOwn(python, name)
        ? python[name]?.interpreter
        : undefined;
    },
  });
}

// Embedded hosts may bundle Recipes while extensions resolve their own copy.
// A process-wide symbol keeps their context registry shared across instances.
const recipeExtensionContextsKey = Symbol.for(
  "@introspection-ai/recipes.extension-contexts.v1",
);

function sharedRecipeExtensionContexts(): WeakMap<
  ExtensionAPI,
  RecipeExtensionSessionContext
> {
  const shared = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = shared[recipeExtensionContextsKey];
  if (existing !== undefined) {
    if (!(existing instanceof WeakMap)) {
      throw new Error(
        "The shared Recipe extension context registry is invalid",
      );
    }
    return existing as WeakMap<ExtensionAPI, RecipeExtensionSessionContext>;
  }

  const contexts = new WeakMap<ExtensionAPI, RecipeExtensionSessionContext>();
  Object.defineProperty(shared, recipeExtensionContextsKey, {
    configurable: false,
    enumerable: false,
    value: contexts,
    writable: false,
  });
  return contexts;
}

const contexts = sharedRecipeExtensionContexts();

export interface RecipeExtensionRegistrationRegistry {
  claim(kind: string, name: string, owner: string): void;
  release(kind: string, name: string, owner: string): void;
  /** The owner of a registration, if any. */
  owner(kind: string, name: string): string | undefined;
}

/** @internal Exact tool names a package extension may keep model-visible. */
export function recipeExtensionToolAllowlist(
  declaredTools: readonly string[],
  hasAgentTool: boolean,
  additionalToolNames: readonly string[] = [],
): ReadonlySet<string> {
  return new Set([
    ...declaredTools,
    ...(hasAgentTool ? ["agent"] : []),
    ...additionalToolNames,
  ]);
}

/** @internal Reject ambiguous registrations across the package closure. */
export function createRecipeExtensionRegistrationRegistry(): RecipeExtensionRegistrationRegistry {
  const owners = new Map<string, string>();
  return {
    claim(kind, name, owner) {
      const key = `${kind}\0${name}`;
      const existing = owners.get(key);
      if (existing === owner) return;
      if (existing) {
        throw new Error(
          `Recipe extension ${kind} registration "${name}" conflicts between ${existing} and ${owner}`,
        );
      }
      owners.set(key, owner);
    },
    release(kind, name, owner) {
      const key = `${kind}\0${name}`;
      const existing = owners.get(key);
      if (existing !== owner) {
        throw new Error(
          `Recipe extension ${owner} cannot unregister ${kind} "${name}" owned by ${existing ?? "<host>"}`,
        );
      }
      owners.delete(key);
    },
    owner(kind, name) {
      return owners.get(`${kind}\0${name}`);
    },
  };
}

/** Return the immutable Recipe identity bound to this extension instance. */
export function getRecipeSessionContext(
  pi: ExtensionAPI,
): RecipeExtensionSessionContext {
  const context = contexts.get(pi);
  if (!context) {
    throw new Error(
      "This extension is not running inside a Recipe-owned session",
    );
  }
  return context;
}

/** Register behavior only when this session is running the named agent. */
export function forAgent(
  pi: ExtensionAPI,
  agentName: string,
  register: (context: RecipeExtensionSessionContext) => void,
): void {
  const context = getRecipeSessionContext(pi);
  if (context.agent.name === agentName) register(context);
}

/** Register behavior only when a session predicate matches. */
export function forRecipeSession(
  pi: ExtensionAPI,
  predicate: (context: RecipeExtensionSessionContext) => boolean,
  register: (context: RecipeExtensionSessionContext) => void,
): void {
  const context = getRecipeSessionContext(pi);
  if (predicate(context)) register(context);
}

/** @internal Bind context before Pi invokes a package extension factory. */
export function bindRecipeExtensionFactory(
  factory: ExtensionFactory,
  context: RecipeExtensionSessionContext,
  registrationRegistry?: RecipeExtensionRegistrationRegistry,
  owner = "<recipe-extension>",
  allowedToolNames?: ReadonlySet<string>,
): ExtensionFactory {
  return async (pi) => {
    const registrationKinds: Record<string, string> = {
      registerTool: "tool",
      registerCommand: "command",
      registerShortcut: "shortcut",
      registerFlag: "flag",
      registerMessageRenderer: "message renderer",
      registerEntryRenderer: "entry renderer",
      registerProvider: "provider",
    };
    const guarded =
      registrationRegistry || allowedToolNames
        ? new Proxy(pi, {
            get(target, property, receiver) {
              const value = Reflect.get(target, property, receiver);
              const kind =
                typeof property === "string"
                  ? registrationKinds[property]
                  : undefined;
              if (
                !kind ||
                !registrationRegistry ||
                typeof value !== "function"
              ) {
                if (
                  property === "setActiveTools" &&
                  typeof value === "function" &&
                  allowedToolNames
                ) {
                  return (names: string[]) => {
                    const undeclared = names.filter(
                      (name) => !allowedToolNames.has(name),
                    );
                    if (undeclared.length > 0) {
                      throw new Error(
                        `Recipe extension attempted to activate undeclared tool(s): ${undeclared.join(", ")}`,
                      );
                    }
                    return value.call(target, names);
                  };
                }
                if (
                  property === "unregisterProvider" &&
                  typeof value === "function" &&
                  registrationRegistry
                ) {
                  return (name: string | { id?: string }) => {
                    const providerName =
                      typeof name === "string" ? name : name.id;
                    if (providerName) {
                      registrationRegistry.release(
                        "provider",
                        providerName,
                        owner,
                      );
                    }
                    return value.call(target, name);
                  };
                }
                return typeof value === "function" ? value.bind(target) : value;
              }
              return (...args: unknown[]) => {
                const registrationName =
                  property === "registerTool"
                    ? (args[0] as { name?: unknown } | undefined)?.name
                    : property === "registerProvider" &&
                        typeof args[0] === "object"
                      ? (args[0] as { id?: unknown } | undefined)?.id
                      : args[0];
                if (typeof registrationName === "string") {
                  registrationRegistry.claim(
                    kind,
                    property === "registerShortcut"
                      ? registrationName.toLowerCase()
                      : registrationName,
                    owner,
                  );
                }
                return value.apply(target, args);
              };
            },
          })
        : pi;
    contexts.set(guarded, context);
    await factory(guarded);
  };
}

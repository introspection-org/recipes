/**
 * Module resolution hooks for the judge runner started as a plain Node
 * process. Recipes' Pi packages are peers: Pi supplies them when it loads the
 * extension, and nothing does for a script. A bare import that does not
 * resolve from Recipes is resolved again from the installed Pi.
 */
let fallback: string | undefined;

export function initialize(data: { parentURL: string }): void {
  fallback = data.parentURL;
}

interface ResolveContext {
  parentURL?: string;
  [key: string]: unknown;
}

export async function resolve(
  specifier: string,
  context: ResolveContext,
  next: (specifier: string, context: ResolveContext) => Promise<unknown>,
): Promise<unknown> {
  try {
    return await next(specifier, context);
  } catch (error) {
    const bare = !/^(\.|\/|node:|file:|data:)/.test(specifier);
    if (
      !fallback ||
      !bare ||
      (error as { code?: string }).code !== "ERR_MODULE_NOT_FOUND"
    ) {
      throw error;
    }
    return next(specifier, { ...context, parentURL: fallback });
  }
}

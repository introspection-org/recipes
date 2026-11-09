import { chromium, type Browser } from "playwright-core";

/**
 * Finding a browser to render with. A future Recipes `browser` package takes
 * this module over; callers keep calling `resolveBrowser`.
 */

/** A Chrome DevTools endpoint the host gives a task, such as a browser sidecar or the developer's own Chrome. */
export const BROWSER_CDP_URL_ENV = "INTROSPECTION_TASK_BROWSER_CDP_URL";
/** The bearer token for that endpoint, when it needs one. */
export const BROWSER_TOKEN_ENV = "INTROSPECTION_TASK_BROWSER_TOKEN";
/** An explicit Chrome or Chromium executable. */
export const BROWSER_EXECUTABLE_ENV = "RECIPE_DOCUMENTS_CHROME";

/** The part of Playwright's `chromium` that `resolveBrowser` uses, so a test can pass a fake. */
export interface BrowserLauncher {
  connectOverCDP(
    endpointURL: string,
    options?: { headers?: Record<string, string> },
  ): Promise<Browser>;
  launch(options?: {
    channel?: string;
    executablePath?: string;
  }): Promise<Browser>;
}

export interface ResolvedBrowser {
  browser: Browser;
  /** `cdp`: the host's endpoint; `executable`: `RECIPE_DOCUMENTS_CHROME`; `chrome`: installed Chrome; `chromium`: a browser Playwright installed. */
  source: "cdp" | "executable" | "chrome" | "chromium";
  /** Closes a launched browser, or disconnects from the endpoint. */
  close(): Promise<void>;
}

const NOT_INSTALLED = /is not found at|Executable doesn't exist at/;

/**
 * The browser to use, in order: the host's DevTools endpoint when
 * `INTROSPECTION_TASK_BROWSER_CDP_URL` is set; the executable
 * `RECIPE_DOCUMENTS_CHROME` names; installed Chrome; a Chromium Playwright
 * installed. Undefined when there is none. A configured endpoint or
 * executable that fails throws rather than falling through.
 */
export async function resolveBrowser(
  env: NodeJS.ProcessEnv = process.env,
  launcher: BrowserLauncher = chromium,
): Promise<ResolvedBrowser | undefined> {
  const resolved = (
    browser: Browser,
    source: ResolvedBrowser["source"],
  ): ResolvedBrowser => ({ browser, source, close: () => browser.close() });

  const endpoint = env[BROWSER_CDP_URL_ENV];
  if (endpoint) {
    const token = env[BROWSER_TOKEN_ENV];
    const browser = await launcher.connectOverCDP(
      endpoint,
      token ? { headers: { Authorization: `Bearer ${token}` } } : {},
    );
    return resolved(browser, "cdp");
  }
  const executablePath = env[BROWSER_EXECUTABLE_ENV];
  if (executablePath)
    return resolved(await launcher.launch({ executablePath }), "executable");
  for (const [options, source] of [
    [{ channel: "chrome" }, "chrome"],
    [{}, "chromium"],
  ] as const) {
    try {
      return resolved(await launcher.launch(options), source);
    } catch (error) {
      if (!(error instanceof Error && NOT_INSTALLED.test(error.message)))
        throw error;
    }
  }
  return undefined;
}

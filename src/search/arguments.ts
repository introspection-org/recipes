/**
 * The arguments `web_search` takes, as the model sees them.
 * `scripts/generate-tool-schemas.mjs` turns `WebSearchArguments` into the
 * JSON Schema in `arguments.generated.ts`: a field's doc comment is its
 * description and its tags are its limits. `{default_results}` is filled in at
 * registration, and `provider` is narrowed to the bound providers, or left out
 * when one is bound. `query`, `provider` and `mode` carry no description:
 * the schema has a size budget (test/search.test.ts), and their names say it.
 */

import type { SearchContent, SearchFreshness, SearchMode } from "./types.js";

export interface WebSearchArguments {
  /** @minLength 1 */
  query: string;
  provider?: string;
  mode?: SearchMode;
  /**
   * Default {default_results}.
   * @asType integer
   * @minimum 1
   * @maximum 10
   */
  max_results?: number;
  /** Only recent pages. */
  freshness?: SearchFreshness;
  /** "x.org" restricts to a site; "-x.org" excludes it. */
  sites?: string[];
  /** context: longer page extracts. Default: snippets. */
  content?: SearchContent;
  /**
   * ISO 3166-1, e.g. US.
   * @pattern ^[A-Z]{2}$
   */
  country?: string;
}

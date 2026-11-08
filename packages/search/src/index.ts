import type { RecipeSearchModule } from "@introspection-ai/recipes/search";

import { braveSearchProvider } from "./brave.js";
import { exaSearchProvider } from "./exa.js";
import { keenableSearchProvider } from "./keenable.js";
import { parallelSearchProvider } from "./parallel.js";
import { perplexitySearchProvider } from "./perplexity.js";
import { tavilySearchProvider } from "./tavily.js";

/** The search providers `web_search` loads from this package. */
export const searchProviders: RecipeSearchModule = {
  kind: "search",
  apiVersion: 1,
  providers: {
    brave: braveSearchProvider,
    exa: exaSearchProvider,
    keenable: keenableSearchProvider,
    parallel: parallelSearchProvider,
    perplexity: perplexitySearchProvider,
    tavily: tavilySearchProvider,
  },
};

export default searchProviders;

export {
  braveSearchProvider,
  exaSearchProvider,
  keenableSearchProvider,
  parallelSearchProvider,
  perplexitySearchProvider,
  tavilySearchProvider,
};

# @introspection-ai/recipe-search

The search providers behind the `web_search` tool of
[`@introspection-ai/recipes`](https://www.npmjs.com/package/@introspection-ai/recipes):
Tavily, Exa, Brave, Keenable, Parallel and Perplexity.

Recipes installs this package alongside itself, so a Recipe does not need to
list it; listing it in `dependencies` pins the version the Recipe uses. Each
provider is a plain `SearchProviderModule`: a capability descriptor, a REST
call through the request the host hands it, and, for the providers with a
hosted MCP server, an adapter that plans and parses one call to the server's
search tool. The package imports only types from Recipes; the host loads it
with `loadSearchProviders` and holds the credentials, the HTTP and MCP
transports, the notes, the spans and the usage record.

```ts
import {
  createWebSearch,
  loadSearchProviders,
} from "@introspection-ai/recipes/search";

const providers = await loadSearchProviders({ recipeDir });
const search = createWebSearch({ providers, bound: ["brave"] });
```

See [docs/search/README.md](https://github.com/introspection-org/recipes/blob/main/docs/search/README.md)
for the contract, each provider's mapping and how a runtime binds them.

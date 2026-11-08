import { egressCredentialLane } from "../egress.js";
import { SearchProviderError, type SearchCapabilities } from "./types.js";

export type SearchEnvironment = Record<string, string | undefined>;

/**
 * The headers that carry a provider's credential, which the Recipe never
 * holds. With the proxy-native egress the header is left out and the egress
 * injects the endpoint's configured header. On the legacy provider lane the
 * session locator rides in the provider's own header, and the egress swaps it
 * for the key. Anywhere else there is no credential path, so the call fails
 * with `not_configured` rather than reaching the provider unauthenticated.
 */
export function egressCredentialHeaders(
  provider: string,
  capabilities: SearchCapabilities,
  env: SearchEnvironment,
): Record<string, string> {
  const lane = egressCredentialLane(env);
  if (lane?.kind === "proxy_native") return {};
  if (lane) {
    const { header, prefix } = capabilities.credential;
    return { [header]: `${prefix ?? ""}${lane.locator}` };
  }
  throw new SearchProviderError({
    code: "not_configured",
    message: `web_search needs an endpoint for ${capabilities.host} (${provider}) on the Introspection egress. Use introspection dev, or a host that supplies the credential.`,
  });
}

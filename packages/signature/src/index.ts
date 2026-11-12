import type { RecipeSignatureModule } from "@introspection-ai/recipes/signature";

import {
  createDocusignSession,
  DOCUSIGN_HOSTS,
  DOCUSIGN_MCP_TOOLS,
  docusignEnvelopeDefinition,
  docusignRecipients,
  docusignSignatureProvider,
  docusignStatus,
  SignatureError,
} from "./docusign.js";

/** The signature providers the `signature` tool loads from this package. */
export const signatureProviders: RecipeSignatureModule = {
  kind: "signature",
  apiVersion: 2,
  providers: {
    docusign: docusignSignatureProvider,
  },
};

export default signatureProviders;

export {
  createDocusignSession,
  DOCUSIGN_HOSTS,
  DOCUSIGN_MCP_TOOLS,
  docusignEnvelopeDefinition,
  docusignRecipients,
  docusignSignatureProvider,
  docusignStatus,
  SignatureError,
};
export type { DocusignSessionOptions } from "./docusign.js";

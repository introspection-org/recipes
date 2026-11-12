import type { RecipeSignatureModule } from "@introspection-ai/recipes/signature";

import {
  createDocusignSession,
  DOCUMENT_NAME_FIELD,
  DOCUMENT_SHA256_FIELD,
  DOCUSIGN_ENVIRONMENTS,
  docusignEnvelope,
  docusignEnvelopeDefinition,
  docusignSignatureProvider,
  SignatureError,
} from "./docusign.js";

/** The signature providers the `signature` tool loads from this package. */
export const signatureProviders: RecipeSignatureModule = {
  kind: "signature",
  apiVersion: 1,
  providers: {
    docusign: docusignSignatureProvider,
  },
};

export default signatureProviders;

export {
  createDocusignSession,
  DOCUMENT_NAME_FIELD,
  DOCUMENT_SHA256_FIELD,
  DOCUSIGN_ENVIRONMENTS,
  docusignEnvelope,
  docusignEnvelopeDefinition,
  docusignSignatureProvider,
  SignatureError,
};
export type {
  DocusignEnvironment,
  DocusignSessionOptions,
} from "./docusign.js";

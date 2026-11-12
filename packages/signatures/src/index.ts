import type { RecipeSignaturesModule } from "@introspection-ai/recipes/signatures";

import {
  createDocusignSession,
  DOCUMENT_NAME_FIELD,
  DOCUMENT_SHA256_FIELD,
  DOCUSIGN_ENVIRONMENTS,
  docusignEnvelope,
  docusignEnvelopeDefinition,
  docusignSignaturesProvider,
  SignaturesError,
} from "./docusign.js";

/** The signatures providers the `signatures` tool loads from this package. */
export const signaturesProviders: RecipeSignaturesModule = {
  kind: "signatures",
  apiVersion: 1,
  providers: {
    docusign: docusignSignaturesProvider,
  },
};

export default signaturesProviders;

export {
  createDocusignSession,
  DOCUMENT_NAME_FIELD,
  DOCUMENT_SHA256_FIELD,
  DOCUSIGN_ENVIRONMENTS,
  docusignEnvelope,
  docusignEnvelopeDefinition,
  docusignSignaturesProvider,
  SignaturesError,
};
export type {
  DocusignEnvironment,
  DocusignSessionOptions,
} from "./docusign.js";

import type { RecipeProductivityModule } from "@introspection-ai/recipes/productivity";

import {
  createGoogleProductivitySession,
  GOOGLE_PRODUCTIVITY_CAPABILITIES,
} from "./session.js";

export {
  CALENDAR_SCOPES,
  CalendarClient,
  type CalendarDateTime,
} from "./calendar.js";
export { composeRawMessage } from "./compose.js";
export {
  DRIVE_SCOPES,
  DriveClient,
  type DriveFile,
  MAX_DOWNLOAD_BYTES,
  MULTIPART_UPLOAD_LIMIT_BYTES,
  NATIVE_EXPORTS,
  type NativeExport,
} from "./drive.js";
export { GoogleProductivityError } from "./errors.js";
export { GMAIL_SCOPES, GmailClient, type GmailMessage } from "./gmail.js";
export {
  collectPages,
  DRIVE_EXPORT_LIMIT_BYTES,
  GOOGLE_ENDPOINTS,
  type GoogleEndpoints,
  type GoogleFetch,
  type GoogleHttpResponse,
  type GoogleRequestInit,
  GoogleTransport,
  type GoogleTransportOptions,
} from "./http.js";
export {
  decodeBase64Url,
  decodeEncodedWords,
  type GmailMessagePart,
  parseMailPayload,
} from "./mime.js";
export { GoogleRestBackend } from "./rest.js";
export {
  createGoogleProductivitySession,
  GOOGLE_PRODUCTIVITY_CAPABILITIES,
  type GoogleProductivitySession,
  type GoogleSessionOverrides,
} from "./session.js";

/**
 * Gmail, Google Calendar and Google Drive as a productivity provider.
 *
 * A plain descriptor: the host builds the `mail`, `calendar` and `drive`
 * tools from `capabilities` and opens one session per person's connection.
 * The package sends a placeholder bearer and the host's egress attaches the
 * person's token, so it holds no credential.
 *
 * ```json
 * { "pi": { "productivity": [{ "provider": "google" }] } }
 * ```
 */
export const googleProductivityModule: RecipeProductivityModule = {
  kind: "productivity",
  // PRODUCTIVITY_MODULE_API_VERSION, written out: a companion imports Recipes' types only.
  apiVersion: 1,
  provider: "google",
  capabilities: GOOGLE_PRODUCTIVITY_CAPABILITIES,
  createSession: (options) => createGoogleProductivitySession(options),
};

export default googleProductivityModule;

import type {
  ProductivityCapabilities,
  ProductivityCommandCapability,
  RecipeProductivityModule,
} from "@introspection-ai/recipes/productivity";

import { createMicrosoftSession } from "./session.js";

export {
  GRAPH_BASE_URL,
  GraphClient,
  GraphError,
  type GraphClientOptions,
  type GraphRequest,
} from "./client.js";
export { MICROSOFT_SCOPES } from "./scopes.js";
export {
  createMicrosoftSession,
  SIMPLE_UPLOAD_LIMIT_BYTES,
  UPLOAD_CHUNK_BYTES,
  wallTime,
} from "./session.js";

const rest = (
  effect: ProductivityCommandCapability["effect"],
  note?: string,
): ProductivityCommandCapability => ({
  effect,
  backend: "rest",
  ...(note ? { note } : {}),
});

/** Every command, served by Microsoft Graph v1.0. */
export const MICROSOFT_PRODUCTIVITY_CAPABILITIES: ProductivityCapabilities = {
  mail: {
    labels: "categories",
    folders: "folders",
    commands: {
      search: rest("read"),
      read: rest("read"),
      fetch_attachment: rest("read"),
      draft: rest("reversible", "The body is sent as plain text."),
      update_draft: rest("reversible"),
      send: rest("irreversible"),
      move: rest(
        "reversible",
        "Outlook folders: inbox, archive, sent, drafts, trash, junk, or a top-level folder's name.",
      ),
      label: rest(
        "reversible",
        "Outlook has no labels: this adds and removes the message's categories.",
      ),
    },
  },
  calendar: {
    commands: {
      list: rest("read", "Times come back in UTC."),
      read: rest("read", "Times come back in UTC."),
      free_busy: rest("read"),
      create: rest("sends"),
      update: rest("sends"),
      respond: rest("sends"),
      cancel: rest("irreversible", "Only the organizer can cancel."),
    },
  },
  drive: {
    commands: {
      search: rest("read"),
      read: rest(
        "read",
        "Only text files have text; Word, Excel and PowerPoint files need drive download.",
      ),
      download: rest("read"),
      upload: rest(
        "reversible",
        "A name already taken gets a new name; nothing is overwritten.",
      ),
    },
  },
};

/**
 * Microsoft 365 (Outlook mail, Outlook calendar, OneDrive and SharePoint) as
 * a productivity provider, over Microsoft Graph v1.0.
 *
 * A plain descriptor: the host builds the `mail`, `calendar` and `drive`
 * tools from it and mints the handles, so this package needs no run-time
 * import of Recipes.
 *
 * ```json
 * { "pi": { "productivity": [{ "provider": "microsoft" }] } }
 * ```
 */
export const microsoftProductivityModule: RecipeProductivityModule = {
  kind: "productivity",
  apiVersion: 1,
  provider: "microsoft",
  capabilities: MICROSOFT_PRODUCTIVITY_CAPABILITIES,
  createSession: ({ http }) => createMicrosoftSession({ http }),
};

export default microsoftProductivityModule;

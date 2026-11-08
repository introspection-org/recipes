import { type GooglePage, type GoogleTransport } from "./http.js";
import type { GmailMessagePart } from "./mime.js";
import { decodeBase64Url } from "./mime.js";

/** OAuth scopes the Gmail commands need (docs/productivity/google.md). */
export const GMAIL_SCOPES = {
  read: "https://www.googleapis.com/auth/gmail.readonly",
  compose: "https://www.googleapis.com/auth/gmail.compose",
  modify: "https://www.googleapis.com/auth/gmail.modify",
} as const;

/** gmail/v1 `Message`. */
export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailMessagePart;
}

export interface GmailThread {
  id: string;
  messages?: GmailMessage[];
}

export interface GmailDraft {
  id: string;
  message?: GmailMessage;
}

export interface GmailLabel {
  id: string;
  name: string;
  type?: "system" | "user";
}

/** A message's headers and part structure, without any part's data, to five levels. */
const STRUCTURE_FIELDS = `id,threadId,labelIds,snippet,internalDate,payload(${partFields(5)})`;

function partFields(depth: number): string {
  const own = "partId,mimeType,filename,headers,body/size,body/attachmentId";
  return depth > 0 ? `${own},parts(${partFields(depth - 1)})` : own;
}

/** The Gmail REST API (`gmail/v1`), one request per method. */
export class GmailClient {
  private readonly me: string;

  constructor(private readonly transport: GoogleTransport) {
    this.me = `${transport.endpoints.gmail}/users/me`;
  }

  /** `users.messages.list`: IDs only; summaries need `getMessage`. */
  async listMessages(
    options: {
      q?: string;
      labelIds?: string[];
      includeSpamTrash?: boolean;
      maxResults?: number;
      pageToken?: string;
    },
    signal?: AbortSignal,
  ): Promise<GooglePage<{ id: string; threadId?: string }>> {
    const page = await this.transport.json<{
      messages?: Array<{ id: string; threadId?: string }>;
      nextPageToken?: string;
    }>(`${this.me}/messages`, {
      operation: "gmail.users.messages.list",
      template: "/gmail/v1/users/{userId}/messages",
      query: {
        q: options.q,
        labelIds: options.labelIds,
        includeSpamTrash: options.includeSpamTrash,
        maxResults: options.maxResults,
        pageToken: options.pageToken,
      },
      scope: GMAIL_SCOPES.read,
      signal,
    });
    return { items: page.messages ?? [], nextPageToken: page.nextPageToken };
  }

  /**
   * `users.messages.get`, whole or as its `structure`: the headers and parts a
   * summary needs (`metadata` has no parts, so no attachments), without data.
   */
  getMessage(
    id: string,
    format: "full" | "structure" = "full",
    signal?: AbortSignal,
  ): Promise<GmailMessage> {
    return this.transport.json<GmailMessage>(
      `${this.me}/messages/${encodeURIComponent(id)}`,
      {
        operation: "gmail.users.messages.get",
        template: "/gmail/v1/users/{userId}/messages/{id}",
        query: {
          format: "full",
          fields: format === "structure" ? STRUCTURE_FIELDS : undefined,
        },
        scope: GMAIL_SCOPES.read,
        signal,
      },
    );
  }

  getThread(id: string, signal?: AbortSignal): Promise<GmailThread> {
    return this.transport.json<GmailThread>(
      `${this.me}/threads/${encodeURIComponent(id)}`,
      {
        operation: "gmail.users.threads.get",
        template: "/gmail/v1/users/{userId}/threads/{id}",
        query: { format: "full" },
        scope: GMAIL_SCOPES.read,
        signal,
      },
    );
  }

  /** `users.messages.attachments.get`: the attachment's decoded bytes. */
  async getAttachment(
    messageId: string,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const body = await this.transport.json<{ data?: string }>(
      `${this.me}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      {
        operation: "gmail.users.messages.attachments.get",
        template:
          "/gmail/v1/users/{userId}/messages/{messageId}/attachments/{id}",
        scope: GMAIL_SCOPES.read,
        signal,
      },
    );
    return decodeBase64Url(body.data ?? "");
  }

  async listLabels(signal?: AbortSignal): Promise<GmailLabel[]> {
    const body = await this.transport.json<{ labels?: GmailLabel[] }>(
      `${this.me}/labels`,
      {
        operation: "gmail.users.labels.list",
        template: "/gmail/v1/users/{userId}/labels",
        scope: GMAIL_SCOPES.read,
        signal,
      },
    );
    return body.labels ?? [];
  }

  createDraft(
    raw: string,
    threadId?: string,
    signal?: AbortSignal,
  ): Promise<GmailDraft> {
    return this.transport.json<GmailDraft>(`${this.me}/drafts`, {
      operation: "gmail.users.drafts.create",
      template: "/gmail/v1/users/{userId}/drafts",
      method: "POST",
      json: { message: { raw, ...(threadId ? { threadId } : {}) } },
      write: true,
      scope: GMAIL_SCOPES.compose,
      signal,
    });
  }

  updateDraft(
    id: string,
    raw: string,
    threadId?: string,
    signal?: AbortSignal,
  ): Promise<GmailDraft> {
    return this.transport.json<GmailDraft>(
      `${this.me}/drafts/${encodeURIComponent(id)}`,
      {
        operation: "gmail.users.drafts.update",
        template: "/gmail/v1/users/{userId}/drafts/{id}",
        method: "PUT",
        json: { id, message: { raw, ...(threadId ? { threadId } : {}) } },
        write: true,
        scope: GMAIL_SCOPES.compose,
        signal,
      },
    );
  }

  getDraft(id: string, signal?: AbortSignal): Promise<GmailDraft> {
    return this.transport.json<GmailDraft>(
      `${this.me}/drafts/${encodeURIComponent(id)}`,
      {
        operation: "gmail.users.drafts.get",
        template: "/gmail/v1/users/{userId}/drafts/{id}",
        query: { format: "full" },
        scope: GMAIL_SCOPES.compose,
        signal,
      },
    );
  }

  /** `users.drafts.send`: never retried, since a second send is a second email. */
  sendDraft(id: string, signal?: AbortSignal): Promise<GmailMessage> {
    return this.transport.json<GmailMessage>(`${this.me}/drafts/send`, {
      operation: "gmail.users.drafts.send",
      template: "/gmail/v1/users/{userId}/drafts/send",
      method: "POST",
      json: { id },
      write: true,
      scope: GMAIL_SCOPES.compose,
      signal,
    });
  }

  modifyMessage(
    id: string,
    change: { addLabelIds?: string[]; removeLabelIds?: string[] },
    signal?: AbortSignal,
  ): Promise<GmailMessage> {
    return this.transport.json<GmailMessage>(
      `${this.me}/messages/${encodeURIComponent(id)}/modify`,
      {
        operation: "gmail.users.messages.modify",
        template: "/gmail/v1/users/{userId}/messages/{id}/modify",
        method: "POST",
        json: change,
        write: true,
        scope: GMAIL_SCOPES.modify,
        signal,
      },
    );
  }
}

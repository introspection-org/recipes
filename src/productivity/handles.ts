import { randomUUID } from "node:crypto";

/** The kinds of item the model addresses by handle, with their prefixes. */
const PREFIXES = {
  message: "msg_",
  thread: "thr_",
  attachment: "att_",
  event: "evt_",
  file: "file_",
  cursor: "cur_",
} as const;

export type ProductivityHandleKind = keyof typeof PREFIXES;

/** A message: its provider id, and the draft id when the session created it as a draft. */
export interface MessageIdentity {
  id: string;
  thread_id?: string;
  /** Set only for a draft this session created; `mail send` requires it. */
  draft_id?: string;
}

interface AttachmentIdentity {
  message_id: string;
  attachment_id: string;
  name: string;
}

interface FileIdentity {
  id: string;
  is_folder?: boolean;
}

interface Identities {
  message: MessageIdentity;
  thread: { id: string };
  attachment: AttachmentIdentity;
  event: { id: string };
  file: FileIdentity;
  cursor: { value: string; scope: string };
}

const NAMES: Record<ProductivityHandleKind, string> = {
  message: "message",
  thread: "thread",
  attachment: "attachment",
  event: "event",
  file: "file",
  cursor: "cursor",
};

/** A handle the session never minted, or of the wrong kind: the model's input, refused before any provider call. */
export class ProductivityHandleError extends Error {}

function mint(prefix: string): string {
  return `${prefix}${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/**
 * Session-scoped opaque handles for one person's connection.
 *
 * The model sees only handles minted here, from items a command returned, so
 * it cannot act on a message, event or file it was never shown, and a
 * provider id it read in a body or invented resolves to nothing. Handles die
 * with the session.
 */
export class ProductivityHandleStore {
  private readonly items = new Map<string, unknown>();
  private readonly byIdentity = new Map<string, string>();

  /** The handle for an item, the same one each time the item comes back. */
  handle<K extends Exclude<ProductivityHandleKind, "cursor">>(
    kind: K,
    identity: Identities[K],
  ): string {
    const key = JSON.stringify([kind, identityKey(kind, identity)]);
    const existing = this.byIdentity.get(key);
    if (existing) {
      const previous = this.items.get(existing) as Identities[K];
      this.items.set(existing, merge(kind, previous, identity));
      return existing;
    }
    const handle = mint(PREFIXES[kind]);
    this.items.set(handle, identity);
    this.byIdentity.set(key, handle);
    return handle;
  }

  /** Point an existing handle at an item's new identity (an Outlook move changes the id). */
  rebind<K extends Exclude<ProductivityHandleKind, "cursor">>(
    kind: K,
    handle: string,
    identity: Identities[K],
  ): void {
    const previous = this.resolve(kind, handle);
    const updated = merge(kind, previous, identity);
    this.items.set(handle, updated);
    this.byIdentity.set(
      JSON.stringify([kind, identityKey(kind, updated)]),
      handle,
    );
  }

  /** Drop a handle: its item is gone (a sent draft, a deleted message). */
  forget(handle: string): void {
    this.items.delete(handle);
    for (const [key, value] of this.byIdentity) {
      if (value === handle) this.byIdentity.delete(key);
    }
  }

  /** A provider cursor, wrapped in a handle valid only for the same command and arguments. */
  cursor(value: string, scope: string): string {
    const handle = mint(PREFIXES.cursor);
    this.items.set(handle, { value, scope });
    return handle;
  }

  resolveCursor(handle: string, scope: string): string {
    const cursor = this.resolve("cursor", handle);
    if (cursor.scope !== scope) {
      throw new ProductivityHandleError(
        `Cursor '${handle}' belongs to another search. Repeat the original arguments with it.`,
      );
    }
    return cursor.value;
  }

  resolve<K extends ProductivityHandleKind>(
    kind: K,
    handle: unknown,
  ): Identities[K] {
    const name = NAMES[kind];
    if (typeof handle !== "string" || !handle.startsWith(PREFIXES[kind])) {
      throw new ProductivityHandleError(
        `Expected a ${name} handle (${PREFIXES[kind]}…) returned by a tool in this session.`,
      );
    }
    const identity = this.items.get(handle);
    if (identity === undefined) {
      throw new ProductivityHandleError(
        `Unknown ${name} handle '${handle}'. Use a handle a tool returned in this session.`,
      );
    }
    return identity as Identities[K];
  }
}

function identityKey(kind: ProductivityHandleKind, identity: unknown): unknown {
  if (kind === "attachment") {
    const attachment = identity as AttachmentIdentity;
    return [attachment.message_id, attachment.attachment_id];
  }
  return (identity as { id: string }).id;
}

function merge<T>(kind: ProductivityHandleKind, previous: T, next: T): T {
  if (kind !== "message") return { ...previous, ...next };
  const before = previous as MessageIdentity;
  const after = next as MessageIdentity;
  return {
    ...before,
    ...after,
    // Authorship of a draft is never lost because a search returned it again.
    ...((after.draft_id ?? before.draft_id)
      ? { draft_id: after.draft_id ?? before.draft_id }
      : {}),
  } as T;
}

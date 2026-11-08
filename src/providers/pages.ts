/**
 * The one pager every provider family's host hands its providers, so a
 * provider follows its vendor's pages without importing anything at run time.
 */

/** How a page names the next one: a vendor's convention, or a reader of the provider's own. */
export type PageNext<Page> =
  /** `nextPageToken`, absent or `isLast: true` on the last page (Google, Jira search). */
  | "nextPageToken"
  /** `@odata.nextLink` (Microsoft Graph). */
  | "odataNextLink"
  /** `hasNextPage` with `cursor` or `nextCursor`, or GraphQL's `pageInfo` (Linear). */
  | "cursor"
  /** `next` (Introspection's lists). */
  | "next"
  /**
   * A numeric offset that advances by the records each page returned (Jira
   * `startAt`). The server's `isLast` or `total` decides the end; a short page
   * does only when it reports neither, since a server may cap a page below
   * the size asked.
   */
  | "offset"
  | ((page: Page) => string | undefined);

export interface PagesRequest<Page, Item> {
  /** One page, after `cursor` (undefined for the first), of at most `size` items when a size is set. */
  fetch(cursor: string | undefined, size: number | undefined): Promise<Page>;
  /** The page's items, every one, before `keep`. */
  items(page: Page): readonly Item[];
  next: PageNext<Page>;
  /** Only these items count and are returned; the pages still advance over the rest. */
  keep?: (item: Item) => boolean;
  /** Stop once this many items are kept; each page asks for no more than the room left. */
  limit?: number;
  /** The size each page asks for when the room left is larger, there is no limit, or `keep` filters. */
  pageSize?: number;
  /** Resume after the cursor a previous call returned. */
  cursor?: string;
  /** How many items there are, when known before reading and the pages may not say (`offset`). */
  total?: number;
  maxPages?: number;
}

export interface PagesResult<Item> {
  items: Item[];
  /** Where the next call resumes, when the pages stopped before the end: at `limit` or `maxPages`. */
  cursor?: string;
}

export type Pages = <Page, Item>(
  request: PagesRequest<Page, Item>,
) => Promise<PagesResult<Item>>;

/** How many pages one call follows unless it says otherwise, so a runaway list cannot hold it open. */
const MAX_PAGES = 20;

function field(page: unknown, name: string): unknown {
  return page && typeof page === "object"
    ? (page as Record<string, unknown>)[name]
    : undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function nextOf<Page>(
  next: PageNext<Page>,
  page: Page,
  read: {
    cursor: string | undefined;
    size: number | undefined;
    count: number;
    total: number | undefined;
  },
): string | undefined {
  if (typeof next === "function") return next(page);
  if (next === "nextPageToken")
    return field(page, "isLast") === true
      ? undefined
      : textOf(field(page, "nextPageToken"));
  if (next === "odataNextLink") return textOf(field(page, "@odata.nextLink"));
  if (next === "next") return textOf(field(page, "next"));
  if (next === "cursor") {
    const info = field(page, "pageInfo");
    const more = field(page, "hasNextPage") ?? field(info, "hasNextPage");
    return more === true
      ? (textOf(field(page, "cursor")) ??
          textOf(field(page, "nextCursor")) ??
          textOf(field(info, "endCursor")))
      : undefined;
  }
  const offset = Number(read.cursor ?? 0) + read.count;
  const reported = field(page, "total");
  const total = typeof reported === "number" ? reported : read.total;
  const isLast = field(page, "isLast");
  if (typeof total === "number")
    return offset < total ? String(offset) : undefined;
  if (typeof isLast === "boolean") return isLast ? undefined : String(offset);
  return read.size !== undefined && read.count < read.size
    ? undefined
    : String(offset);
}

export const pages: Pages = async <Page, Item>(
  request: PagesRequest<Page, Item>,
): Promise<PagesResult<Item>> => {
  const items: Item[] = [];
  let cursor = request.cursor;
  for (let read = 0; read < (request.maxPages ?? MAX_PAGES); read += 1) {
    const room =
      request.limit === undefined ? undefined : request.limit - items.length;
    // A filtered page loses items to the filter, so it asks for a whole page.
    const size =
      room === undefined || (request.keep && request.pageSize !== undefined)
        ? request.pageSize
        : Math.min(room, request.pageSize ?? room);
    const page = await request.fetch(cursor, size);
    const found = request.items(page);
    items.push(...(request.keep ? found.filter(request.keep) : found));
    const following = nextOf(request.next, page, {
      cursor,
      size,
      count: found.length,
      total: request.total,
    });
    // A server that ignores the cursor hands back the same page.
    if (!following || following === cursor || found.length === 0)
      return done(items);
    if (request.limit !== undefined && items.length >= request.limit)
      return done(items, following);
    cursor = following;
  }
  return done(items, cursor);

  // A filtered list is cut to the limit; an unfiltered page comes back whole,
  // since a server may not size a page to the room left, and its host keeps
  // the rest for the next one.
  function done(kept: Item[], resume?: string): PagesResult<Item> {
    const cut =
      request.keep && request.limit !== undefined
        ? kept.slice(0, request.limit)
        : kept;
    return resume === undefined
      ? { items: cut }
      : { items: cut, cursor: resume };
  }
};

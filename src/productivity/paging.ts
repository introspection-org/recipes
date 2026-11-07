import type { ProductivityHandleStore } from "./handles.js";

/** What a provider returned for one page: possibly more items than asked for. */
export interface ProviderPage<T> {
  readonly items: readonly T[];
  readonly cursor?: string;
}

/** At most `limit` items, and a cursor handle when more remain. */
export interface HostPage<T> {
  readonly items: T[];
  readonly cursor?: string;
}

/**
 * One page of a listing for the model, never longer than `limit`.
 *
 * A provider may return more items than it was asked for (a provider page it
 * cannot cut, a server that ignores the page size). The items past `limit`
 * are kept in the cursor handle beside the provider's own cursor, and the next
 * call with that handle serves them first, so nothing a provider returned is
 * skipped and the provider's cursor only ever resumes after the last item it
 * returned.
 */
export async function collectPage<T>(
  handles: ProductivityHandleStore,
  scope: string,
  request: { readonly limit: number; readonly cursor?: string },
  fetch: (page: { limit: number; cursor?: string }) => Promise<ProviderPage<T>>,
): Promise<HostPage<T>> {
  const resumed =
    request.cursor !== undefined
      ? handles.resolveCursor<T>(request.cursor, scope)
      : undefined;
  const items: T[] = [...(resumed?.overflow ?? [])];
  let cursor = resumed?.value;
  if (items.length < request.limit && (!resumed || cursor !== undefined)) {
    const page = await fetch({
      limit: request.limit - items.length,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    items.push(...page.items);
    cursor = page.cursor || undefined;
  }
  const overflow = items.splice(request.limit);
  return {
    items,
    ...(cursor !== undefined || overflow.length > 0
      ? {
          cursor: handles.cursor(
            { ...(cursor !== undefined ? { value: cursor } : {}), overflow },
            scope,
          ),
        }
      : {}),
  };
}

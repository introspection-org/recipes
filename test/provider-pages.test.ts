import { describe, expect, it } from "vitest";

import { pages, type PagesRequest } from "../src/providers/pages.js";

/** A pager over `book`, recording each call's cursor and size. */
function over<Page>(
  book: Record<string, Page>,
  request: Omit<PagesRequest<Page, number>, "fetch">,
) {
  const calls: Array<{ cursor: string | undefined; size: number | undefined }> =
    [];
  const run = pages({
    ...request,
    fetch: async (cursor, size) => {
      calls.push({ cursor, size });
      return book[cursor ?? "start"]!;
    },
  });
  return { calls, run };
}

describe("the provider pager", () => {
  const google = {
    start: { items: [1, 2, 3], nextPageToken: "p2" },
    p2: { items: [4, 5], nextPageToken: "p3" },
    p3: { items: [6] },
  };

  it("follows nextPageToken to the limit, asking each page for the room left", async () => {
    const all = over(google, {
      items: (page) => page.items,
      next: "nextPageToken",
      limit: 10,
    });
    await expect(all.run).resolves.toEqual({ items: [1, 2, 3, 4, 5, 6] });
    expect(all.calls.map((call) => call.size)).toEqual([10, 7, 5]);

    const some = over(google, {
      items: (page) => page.items,
      next: "nextPageToken",
      limit: 5,
    });
    await expect(some.run).resolves.toEqual({
      items: [1, 2, 3, 4, 5],
      cursor: "p3",
    });
  });

  it("resumes after a cursor and stops at the page cap with one", async () => {
    const resumed = over(google, {
      items: (page) => page.items,
      next: "nextPageToken",
      cursor: "p2",
    });
    await expect(resumed.run).resolves.toEqual({ items: [4, 5, 6] });

    const capped = over(google, {
      items: (page) => page.items,
      next: "nextPageToken",
      maxPages: 2,
    });
    await expect(capped.run).resolves.toEqual({
      items: [1, 2, 3, 4, 5],
      cursor: "p3",
    });
  });

  it("stops on an empty page, a repeated token, and isLast", async () => {
    const empty = over(
      { start: { items: [], nextPageToken: "p2" } },
      { items: (page) => page.items, next: "nextPageToken" },
    );
    await expect(empty.run).resolves.toEqual({ items: [] });

    const stuck = over(
      {
        start: { items: [1], nextPageToken: "p2" },
        p2: { items: [2], nextPageToken: "p2" },
      },
      { items: (page) => page.items, next: "nextPageToken" },
    );
    await expect(stuck.run).resolves.toEqual({ items: [1, 2] });
    expect(stuck.calls).toHaveLength(2);

    const last = over(
      { start: { items: [1], nextPageToken: "p2", isLast: true } },
      { items: (page) => page.items, next: "nextPageToken" },
    );
    await expect(last.run).resolves.toEqual({ items: [1] });
  });

  it("reads OData links, cursors only while hasNextPage, and next", async () => {
    const odata = over(
      {
        start: { value: [1], "@odata.nextLink": "l2" },
        l2: { value: [2] },
      },
      { items: (page) => page.value, next: "odataNextLink" },
    );
    await expect(odata.run).resolves.toEqual({ items: [1, 2] });

    const linear = over(
      {
        start: { nodes: [1], hasNextPage: true, cursor: "c2" },
        c2: { nodes: [2], pageInfo: { hasNextPage: true, endCursor: "c3" } },
        c3: { nodes: [3], hasNextPage: false, cursor: "c4" },
      },
      { items: (page) => page.nodes, next: "cursor" },
    );
    await expect(linear.run).resolves.toEqual({ items: [1, 2, 3] });

    const dataPlane = over(
      { start: { records: [1], next: "n2" }, n2: { records: [2], next: null } },
      { items: (page) => page.records, next: "next" },
    );
    await expect(dataPlane.run).resolves.toEqual({ items: [1, 2] });
  });

  it("pages an offset by the rows returned, ending on total, then isLast, then a short page", async () => {
    // The server caps the page below what was asked; its total says more remain.
    const capped = over(
      {
        start: { values: [1], total: 2, isLast: false },
        "1": { values: [2], total: 2, isLast: false },
      },
      { items: (page) => page.values, next: "offset", pageSize: 100 },
    );
    await expect(capped.run).resolves.toEqual({ items: [1, 2] });
    expect(capped.calls.map((call) => call.cursor)).toEqual([undefined, "1"]);

    const flagged = over(
      {
        start: { values: [1], isLast: false },
        "1": { values: [2], isLast: true },
      },
      { items: (page) => page.values, next: "offset", pageSize: 100 },
    );
    await expect(flagged.run).resolves.toEqual({ items: [1, 2] });

    const silent = over(
      { start: { values: [1, 2] }, "2": { values: [3] } },
      { items: (page) => page.values, next: "offset", pageSize: 100 },
    );
    await expect(silent.run).resolves.toEqual({ items: [1, 2] });

    // A total known beforehand counts when the pages do not report one.
    const known = over(
      { start: { values: [1] }, "1": { values: [2] } },
      { items: (page) => page.values, next: "offset", pageSize: 1, total: 2 },
    );
    await expect(known.run).resolves.toEqual({ items: [1, 2] });
  });

  it("filters across pages to the limit, advancing an offset by every row", async () => {
    const run = over(
      {
        start: { values: [1, 2, 3], total: 6 },
        "3": { values: [4, 5, 6], total: 6 },
      },
      {
        items: (page) => page.values,
        next: "offset",
        keep: (item) => item % 2 === 0,
        limit: 2,
        pageSize: 3,
      },
    );
    await expect(run.run).resolves.toEqual({
      items: [2, 4],
      cursor: undefined,
    });
    expect(run.calls.map((call) => [call.cursor, call.size])).toEqual([
      [undefined, 3],
      ["3", 3],
    ]);
  });

  it("returns an unfiltered page whole past the limit, and a filtered one cut to it", async () => {
    const whole = over(
      { start: { items: [1, 2, 3], nextPageToken: "p2" } },
      { items: (page) => page.items, next: "nextPageToken", limit: 2 },
    );
    await expect(whole.run).resolves.toEqual({
      items: [1, 2, 3],
      cursor: "p2",
    });

    const cut = over(
      { start: { items: [1, 2, 3], nextPageToken: "p2" } },
      {
        items: (page) => page.items,
        next: "nextPageToken",
        keep: () => true,
        limit: 2,
      },
    );
    await expect(cut.run).resolves.toEqual({ items: [1, 2], cursor: "p2" });
  });

  it("takes a provider's own reader", async () => {
    const own = over(
      { start: { rows: [1], then: "x" }, x: { rows: [2] } },
      {
        items: (page) => page.rows,
        next: (page) => ("then" in page ? page.then : undefined),
      },
    );
    await expect(own.run).resolves.toEqual({ items: [1, 2] });
  });
});

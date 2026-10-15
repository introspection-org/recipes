// Written by hand for the tests, in the shape `introspection bindings mcp types` generates.
export interface Contract {
  "list-notes": {
    args: {
      limit: number;
      order: "asc" | "desc";
      filter?: { op: "eq" | "contains" | "gt"; value: string };
      include_archived?: boolean;
    };
    defaults: { limit: 10; order: "asc" };
  };
  "search-everything": { args: { query?: string } };
  "create-note": { args: { title: string; owner?: string } };
  "get-note": { args: { id: string }; result: { id: string; title: string } };
}

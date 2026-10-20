// What `introspection bindings mcp types tools.json` generates for the tools above.
export type Contract = {
  "list-records": { args: { object: string; limit?: number }; defaults: { limit: 50 } };
  "get-records-by-ids": { args: { object: string; record_ids: string[] } };
  "update-record": { args: { object: string; record_id: string; values: Record<string, unknown> } };
};

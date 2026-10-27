// Written by `introspection bindings mcp observe`. Do not edit.
// biome-ignore-all format: the CLI writes this file and reads it back
// prettier-ignore
export default {
  "version": 4,
  "server": "notes",
  "tools": {
    "list-notes": {
      "calls": 2,
      "errors": 0,
      "sampled": 2,
      "result": {
        "format": "text",
        "prefix": "limit: <int>",
        "lines": [2, 5]
      }
    },
    "get-note": {
      "calls": 3,
      "errors": 0,
      "sampled": 3,
      "result": {
        "format": "json",
        "schema": {
          "type": "object",
          "properties": {
            "id": { "type": "string" },
            "title": { "type": "string" }
          },
          "required": ["id", "title"]
        }
      }
    }
  }
} as const;

// Written by `introspection bindings mcp capture`. Do not edit.
// biome-ignore-all format: the CLI writes this file and reads it back
// prettier-ignore
export default {
  "tools": [
    {
      "name": "list-notes",
      "description": "List notes, oldest first unless told otherwise.",
      "inputSchema": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
          "limit": {
            "type": "number",
            "minimum": 1,
            "maximum": 50,
            "default": 10
          },
          "order": {
            "type": "string",
            "enum": [
              "asc",
              "desc"
            ],
            "default": "asc"
          },
          "filter": {
            "type": "object",
            "properties": {
              "op": {
                "type": "string",
                "enum": [
                  "eq",
                  "contains",
                  "gt"
                ]
              },
              "value": {
                "type": "string"
              }
            },
            "required": [
              "op",
              "value"
            ],
            "additionalProperties": false
          },
          "include_archived": {
            "type": "boolean"
          }
        },
        "additionalProperties": false
      },
      "annotations": {
        "readOnlyHint": true
      }
    },
    {
      "name": "search-everything",
      "description": "A tool the Recipe does not allow.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string"
          }
        }
      }
    },
    {
      "name": "create-note",
      "title": "Create a note",
      "description": "Create a note.",
      "inputSchema": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
          "title": {
            "type": "string",
            "minLength": 1
          },
          "owner": {
            "type": "string",
            "format": "uuid"
          }
        },
        "required": [
          "title"
        ],
        "additionalProperties": false
      },
      "annotations": {
        "readOnlyHint": false
      },
      "_meta": {
        "example.test/captured": true
      }
    },
    {
      "name": "get-note",
      "description": "Read one note.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          }
        },
        "required": [
          "id"
        ]
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "title": {
            "type": "string"
          }
        },
        "required": [
          "id",
          "title"
        ],
        "additionalProperties": false
      },
      "annotations": {
        "readOnlyHint": true
      }
    }
  ]
} as const;

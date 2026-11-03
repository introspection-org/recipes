// Written by `introspection bindings mcp capture`. Do not edit.
// biome-ignore-all format: the CLI writes this file and reads it back
// prettier-ignore
export default {
  "tools": [
    {
      "name": "send-email",
      "description": "Send an email.",
      "inputSchema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "to": {
            "type": "array",
            "items": {
              "type": "string",
              "format": "email"
            },
            "minItems": 1
          },
          "subject": {
            "type": "string"
          }
        },
        "required": [
          "to",
          "subject"
        ],
        "additionalProperties": false
      },
      "execution": {
        "taskSupport": "forbidden"
      }
    }
  ]
} as const;

# @introspection-ai/recipe-documents-docx

The Word (`.docx`) format for the Recipes [`documents` tool](../../../docs/documents.md):
`read`, `propose_edits`, `comment`, `respond` and `remove_section`, on paper-docx.
`render` is not registered.

```json
{ "pi": { "documents": [{ "format": "docx" }] } }
```

The helpers in `python/` run with the Recipe's `pi.runtime.python` environment, which must
provide `paper-docx==0.2.0`. `python/uv.lock` pins what the tests run on.

Licences: the anchoring and section removal follow RedlineBench's redline engine (MIT,
Crosby Legal), see `python/recipe_documents_docx/LICENSE-redline-bench`. The rest is Apache-2.0.

# @introspection-ai/recipe-documents-pdf

The PDF format for the Recipes [`documents` tool](../../../docs/documents.md): `read` and
`render`. PDFs are never changed, so the write commands are not registered.

```json
{ "pi": { "documents": [{ "format": "pdf" }] } }
```

## Reading paths

Every `read` result starts with the path it used:

- **text**: pypdfium2's text for each page, in reading order, with filled form fields and
  page comments. Fast (about 5 ms for a legal deal brief) and enough for prose.
- **tables**: `read` with `tables: true` also returns each table as rows of cells, from
  pdfplumber. Ask for it on contracts with fee schedules, SLA grids or price tables, where
  plain text loses which figure belongs to which row. It needs the `tables` extra; without it
  `read` returns the text and a note saying the extra is missing.
- **page images (no text layer)**: a page with no text is a scan. `read` says so and names
  the pages; `render` writes them as PNG files and returns their paths, and the agent opens
  each with Pi's `read` tool. `render` also suits signatures, stamps, charts and layout.

## Python

`python/pdf.py` runs in this package's own Python environment. The package declares it in
`package.json#pi.runtime.python` (`python/pyproject.toml`, locked by `python/uv.lock`, with
pypdfium2 and pillow), and the host prepares it with uv beside the Recipe and passes its
interpreter to the adapter. A Recipe declares no Python for PDFs: it needs none of its own,
and one it does declare is its agent's shell environment, which the helper doesn't use. This
needs `@introspection-ai/recipes` 0.39.0 or later.

The interpreter is the first of:

1. `RECIPE_DOCUMENTS_PYTHON`, an explicit override;
2. the package environment's interpreter, from the host;
3. `VIRTUAL_ENV` (`bin/python`, or `Scripts\python.exe` on Windows), for a host that
   prepares no package environment;
4. `python3` on `PATH`.

### Tables

The package environment is installed without extras, so it has no pdfplumber: `read` with
`tables: true` returns the text and a note that the `tables` extra is missing. Choosing the
extra from a Recipe is not supported yet. Until it is, a host that needs tables points
`RECIPE_DOCUMENTS_PYTHON` at an environment synced from this package's lock with the extra:

```sh
uv sync --frozen --no-dev --extra tables --project <package>/python
```

The extra is optional because of its size: pypdfium2 installs at about 7.7 MB, pdfplumber at
about 41 MB (it brings pdfminer.six, cryptography, Pillow and cffi). The helper imports
pdfplumber only when a read asks for tables, and nothing is fetched at run time.

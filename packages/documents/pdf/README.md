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

`python/pdf.py` runs with the Recipe's `pi.runtime.python` environment, which must provide
pypdfium2 and pillow. For tables, add pdfplumber, the `tables` extra, to the Recipe's
`python/pyproject.toml` and lock it with uv:

```toml
dependencies = ["pypdfium2==5.14.0", "pillow==13.0.0", "pdfplumber==0.11.10"]
```

The extra is optional because of its size: pypdfium2 installs at about 7.7 MB, pdfplumber at
about 41 MB (it brings pdfminer.six, cryptography, Pillow and cffi). A profile for contract
review may recommend it. The helper imports pdfplumber only when a read asks for tables, and
nothing is fetched at run time. `python/pyproject.toml` and `uv.lock` here pin the versions
the tests run on, with `tables` as an optional dependency.

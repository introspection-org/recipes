# @introspection-ai/recipe-documents-html

The HTML format for the Recipes [`documents` tool](../../../docs/documents/README.md): `read`
and `render` for `.html`, `.htm` and `.svg` files. Pages are never changed, so the write
commands are not registered.

```json
{ "pi": { "documents": [{ "format": "html" }] } }
```

Recipes installs this package alongside itself (an `optionalDependencies` entry), so a
Recipe that declares the format without listing the package uses that copy. Declare it in
`peerDependencies` (`"@introspection-ai/recipe-documents-html": ">=X.Y.Z"`), which says the
platform provides it. To pin an exact version, list `"@introspection-ai/recipe-documents-html": "X.Y.Z"` in
`dependencies` instead, and the Recipe's copy wins. `X.Y.Z` stands for a released version (`npm view @introspection-ai/recipe-documents-html version`): a peer takes an open floor, `>=X.Y.Z`, and a pin an exact version.

## read

The page as markdown: linkedom parses it, scripts and styles are dropped, and turndown
writes headings, lists and GFM tables. Each chart, an outermost `<figure>` or an `<svg>`
outside any figure, becomes a `[chart N: label]` line, labelled by its caption, its
`aria-label` or the SVG's `<title>`. `N` is the number `render` takes in `pages`.

## render

PNG files at 2x, returned as paths the agent opens with Pi's `read` tool, at most 10 per
call. With no `pages`, the full page in light and in dark (`prefers-color-scheme`) and every
chart; `pages: "2-3"` renders those charts alone. Each chart is its own element screenshot,
so a chart is not shrunk inside a tall page image.

The browser is found by `resolveBrowser()`, in order:

1. `INTROSPECTION_TASK_BROWSER_CDP_URL`, a Chrome DevTools endpoint the host gives the
   task, with `INTROSPECTION_TASK_BROWSER_TOKEN` as its bearer token;
2. `RECIPE_DOCUMENTS_CHROME`, a Chrome or Chromium executable;
3. installed Chrome;
4. a Chromium Playwright installed.

The page is loaded with `setContent`, so it must be self-contained: an endpoint's browser
may not share the task's filesystem. `resolveBrowser` is exported for a future Recipes
`browser` package to take over; callers keep calling it.

With no browser, each inline `<svg>` chart is drawn by resvg, with the page's `<style>`
rules copied into it, and the result begins `Path: SVG charts only`. It names what it
could not draw: the full page, and a figure with no inline SVG (a `<canvas>` or `<img>`).
resvg does not resolve CSS custom properties, and text needs fonts installed; check
charts that use either with a browser.

A second renderer implements `HtmlRenderer` (`render(request)` returning images and what
it skipped); `BrowserHtmlRenderer` and `ResvgHtmlRenderer` are the two here.

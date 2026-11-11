# introspection-recipe-check for Python

Native Python bindings for the pure, I/O-free
`introspection-recipe-check` validation engine.

```python
from introspection_recipe_check import check_recipe_files

report = check_recipe_files(
    {
        "files": [
            {
                "path": "package.json",
                "content": '{"name":"demo","pi":{}}',
            }
        ]
    }
)
```

The binding performs no filesystem I/O. Paths are relative to the Recipe root,
and missing `content` means the host supplied file identity without source
text.

`list_recipe_suggestions(snapshot)` returns the same snapshot's suggestions:
the prompt templates marked `suggest`, in file order, as `Suggestion` values
(`name`, `description`, `argument_hint`, `text`, `placeholders` and `agents`,
which is `None` when every agent offers it). Pass `agent="<name>"` for only
the suggestions that agent offers. It
reads them exactly as `listRecipeSuggestions` in `@introspection-ai/recipes`
does, so a host can offer them (as chat chips, say) without starting Pi.

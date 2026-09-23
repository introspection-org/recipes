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

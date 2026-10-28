"""Import path the CLI selects the adapter by.

``introspection eval run --runner harbor`` names
``introspection_harbor.agent:IntrospectionRecipeAgent``. Which adapter that
resolves to is chosen by ``INTROSPECTION_HARBOR_ADAPTER``:

- ``runtime`` (default): the trial image is the Runtime image; its Recipe is
  either baked or materialized by the task before the image's Pi is exposed
  (``runtime_agent``).
- ``bootstrap``: a foreign trial image; the Recipe, Pi and the CLI are
  installed into it, then the run is the same (``bootstrap_agent``).
- ``native``: each step is a run on the trial's evaluation task, so the
  Runtime runs the Recipe and the platform stores the conversation
  (``native_agent``). Needs the Introspection environment.
"""

from __future__ import annotations

import os

from harbor.agents.base import BaseAgent

from .bootstrap_agent import IntrospectionBootstrapAgent
from .native_agent import IntrospectionNativeAgent
from .runtime_agent import IntrospectionRecipeAgent as _RuntimeAgent

ADAPTER_ENV = "INTROSPECTION_HARBOR_ADAPTER"
ADAPTERS: dict[str, type[BaseAgent]] = {
    "runtime": _RuntimeAgent,
    "bootstrap": IntrospectionBootstrapAgent,
    "native": IntrospectionNativeAgent,
}


def adapter_class(selected: str | None = None) -> type[BaseAgent]:
    """The adapter ``INTROSPECTION_HARBOR_ADAPTER`` (or ``selected``) names."""

    name = (
        selected if selected is not None else os.environ.get(ADAPTER_ENV, "")
    ).strip()
    if not name:
        return _RuntimeAgent
    try:
        return ADAPTERS[name]
    except KeyError:
        choices = ", ".join(sorted(ADAPTERS))
        raise ValueError(
            f"{ADAPTER_ENV} must be one of {choices}, not {name!r}"
        ) from None


IntrospectionRecipeAgent = adapter_class()

__all__ = ["ADAPTERS", "IntrospectionRecipeAgent", "adapter_class"]

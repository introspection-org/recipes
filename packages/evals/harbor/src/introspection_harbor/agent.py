"""Import path the CLI selects the baked-image adapter by.

``introspection eval run --runner harbor`` names
``introspection_harbor.agent:IntrospectionRecipeAgent``; the adapter itself
lives in ``runtime_agent``.
"""

from .runtime_agent import IntrospectionRecipeAgent

__all__ = ["IntrospectionRecipeAgent"]

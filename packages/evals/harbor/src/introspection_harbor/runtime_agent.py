"""Harbor adapter for a trial whose image is the Runtime image.

The Data Plane published that image for the Recipe, so everything the agent
needs is already inside it: Pi, the Recipes extension under the runtime link,
and the Introspection CLI. The Recipe at ``/opt/introspection/recipe`` is either
the baked source or an exact commit prepared by runtime-agent before Harbor
starts. The adapter installs nothing; it only makes the image's Pi reachable.
"""

from __future__ import annotations

from typing import override

from harbor.environments.base import BaseEnvironment

from .base import (
    RUNTIME_PROVIDER_HTTP_EXTENSION_PATH,
    RecipeAgentBase,
    pi_launcher_command,
    prepare_recipe_command,
)


class IntrospectionRecipeAgent(RecipeAgentBase):
    """Run the Recipe materialized in the selected Runtime image."""

    provider_http_extension_path = RUNTIME_PROVIDER_HTTP_EXTENSION_PATH

    @staticmethod
    @override
    def name() -> str:
        return "introspection-recipe"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        """Verify the materialized Recipe and expose the image's Pi on ``PATH``.

        Nothing is downloaded: the launcher only points at the Pi that the
        Runtime image already carries, and it is skipped when the image
        (for example the Operator image) provides ``pi`` itself.
        """

        await self.exec_as_agent(environment, command=pi_launcher_command())
        await self.exec_as_agent(environment, command=prepare_recipe_command())
        await self.upload_replay_context(environment)

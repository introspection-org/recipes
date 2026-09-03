"""Harbor adapter for a trial whose image is the Runtime image.

The Data Plane published that image for the Recipe, so everything the agent
needs is already inside it: the Recipe at ``/opt/introspection/recipe``, Pi
and the Recipes extension under the runtime link, and the Introspection CLI.
The adapter installs nothing; it only makes the image's Pi reachable.
"""

from __future__ import annotations

from typing import override

from harbor.environments.base import BaseEnvironment

from .base import BAKED_RECIPE_DIR, RecipeAgentBase, pi_launcher_command


class IntrospectionRecipeAgent(RecipeAgentBase):
    """Run the Recipe baked into the trial image, as selected by the CLI."""

    @staticmethod
    @override
    def name() -> str:
        return "introspection-recipe"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        """Verify the baked Recipe and expose the image's Pi on ``PATH``.

        Nothing is downloaded: the launcher only points at the Pi that the
        Runtime image already carries, and it is skipped when the image
        (for example the Operator image) provides ``pi`` itself.
        """

        await self.exec_as_root(environment, command=pi_launcher_command())
        await self.exec_as_agent(
            environment,
            command=(
                f"test -f {BAKED_RECIPE_DIR}/package.json && "
                f"if [ -f {BAKED_RECIPE_DIR}/.pi/mcp.local.example.json ] && "
                f"[ ! -f {BAKED_RECIPE_DIR}/.pi/mcp.local.json ]; then "
                f"cp {BAKED_RECIPE_DIR}/.pi/mcp.local.example.json "
                f"{BAKED_RECIPE_DIR}/.pi/mcp.local.json; fi"
            ),
        )
        await self.upload_replay_context(environment)

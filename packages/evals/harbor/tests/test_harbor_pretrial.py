"""Harbor's own check of an agent, run against this adapter's agents.

Harbor refuses a trial before its environment starts when the task asks for
something the agent does not declare. The adapter's other tests call its
command builders and never reach that check, so an adapter that binds a task's
MCP servers without declaring them passed every test and failed every trial.
"""

from __future__ import annotations

import unittest
from types import SimpleNamespace

from harbor.agents.base import BaseAgent
from harbor.models.task.config import TaskConfig
from harbor.trial.trial import Trial

from introspection_harbor.bootstrap_agent import IntrospectionBootstrapAgent
from introspection_harbor.runtime_agent import IntrospectionRecipeAgent

_TASK_WITH_MCP_SERVERS = """
schema_version = "1.4"
[task]
name = "suite/case"
description = "A task whose fake provider is an MCP sidecar"
[agent]
timeout_sec = 180.0
[verifier]
timeout_sec = 300.0
[environment]
cpus = 1
memory_mb = 512

[[environment.mcp_servers]]
name = "crm"
transport = "streamable-http"
url = "http://fakes:7353/crm/mcp"
"""


def _check(agent: type[BaseAgent]) -> None:
    """Run Harbor's pre-trial check for *agent* on a task with MCP servers."""

    task = SimpleNamespace(
        config=TaskConfig.model_validate_toml(_TASK_WITH_MCP_SERVERS)
    )
    trial = SimpleNamespace(
        agent=agent,
        agent_environment=SimpleNamespace(os=task.config.environment.os),
        config=SimpleNamespace(
            agent=SimpleNamespace(name=agent.name(), skills=[], mcp_servers=[])
        ),
        task=task,
        _effective_skills_dir=None,
    )
    Trial._validate_agent_capabilities(trial)


class PreTrialCheckTest(unittest.TestCase):
    def test_harbor_accepts_both_agents_for_a_task_with_mcp_servers(self) -> None:
        for agent in (IntrospectionRecipeAgent, IntrospectionBootstrapAgent):
            with self.subTest(agent=agent.__name__):
                _check(agent)

    def test_the_check_refuses_an_agent_that_declares_nothing(self) -> None:
        # Without this, a Harbor that stopped checking would pass the test above.
        class Undeclared(BaseAgent):
            @staticmethod
            def name() -> str:
                return "undeclared"

            def version(self) -> str:
                return "0"

            async def setup(self, environment) -> None:
                return None

            async def run(self, instruction, environment, context) -> None:
                return None

        with self.assertRaisesRegex(ValueError, "does not support MCP servers"):
            _check(Undeclared)


if __name__ == "__main__":
    unittest.main()

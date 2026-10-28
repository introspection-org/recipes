"""The native adapter: each Harbor step is a run on the trial's evaluation task."""

from __future__ import annotations

import asyncio
import json
import logging
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from harbor.environments.base import ExecResult
from harbor.models.agent.context import AgentContext
from harbor.models.task.config import MCPServerConfig
from introspection_sdk.schemas.agui import RunErrorEvent
from introspection_sdk.schemas.genai_span import GenAiSpan
from introspection_sdk.schemas.tasks import TaskPrompt

from introspection_harbor import native_agent
from introspection_harbor.native_agent import IntrospectionNativeAgent, NativeRunError
from introspection_harbor.task_environment import IntrospectionEnvironment

SPEC = {
    "schema_version": 2,
    "candidate": {"runtime": "refunds", "agent": None, "model": None},
    "input": {},
}


def _span(second: int, prompt: str, reply: str) -> GenAiSpan:
    """A chat span starting *second* seconds from now, so it belongs to this step."""

    return GenAiSpan.model_validate(
        {
            "trace_id": "conversation-1",
            "span_id": f"span-{second}",
            "start_time": (datetime.now(UTC) + timedelta(seconds=second)).isoformat(),
            "attributes": {
                "gen_ai": {
                    "conversation": {"id": "conversation-1"},
                    "provider": {"name": "anthropic"},
                    "response": {"model": "claude-sonnet-4-6"},
                    "usage": {"input_tokens": 7, "output_tokens": 2},
                    "input": {
                        "messages": [
                            {
                                "role": "user",
                                "parts": [{"type": "text", "content": prompt}],
                            }
                        ]
                    },
                    "output": {
                        "messages": [
                            {
                                "role": "assistant",
                                "parts": [{"type": "text", "content": reply}],
                            }
                        ]
                    },
                }
            },
        }
    )


class _Items:
    """`conversations.items.list` as an async-iterable pager, one read per call."""

    def __init__(self, *reads: list[GenAiSpan]) -> None:
        self._reads = list(reads)
        self.calls = 0

    def list(self, conversation_id: str):
        self.calls += 1
        spans = self._reads.pop(0) if len(self._reads) > 1 else self._reads[0]

        async def pager():
            for span in spans:
                yield span

        return pager()


def _handle(*events, block: asyncio.Event | None = None) -> Mock:
    async def stream(**_):
        for event in events:
            yield event
        if block is not None:
            await block.wait()

    handle = Mock()
    handle.run = SimpleNamespace(id="run-1")
    handle.stream = stream
    handle.cancel = AsyncMock()
    return handle


def _fixture(
    handle: Mock, items: _Items
) -> tuple[IntrospectionNativeAgent, IntrospectionEnvironment]:
    agent = object.__new__(IntrospectionNativeAgent)
    agent._spec = SPEC
    agent._ingest_timeout = 5.0
    agent._trajectory = None
    agent._step = None
    agent._ran = False
    agent._prompt_template_path = None
    agent.mcp_servers = []
    agent.logs_dir = Path(tempfile.mkdtemp())
    agent.logger = logging.getLogger(__name__)

    environment = object.__new__(IntrospectionEnvironment)
    environment._task_id = "task-1"
    environment._client = Mock()
    environment._client.tasks.runs.create = AsyncMock(return_value=handle)
    environment._client.tasks.get = AsyncMock(
        return_value=SimpleNamespace(metadata={"conversation_id": "conversation-1"})
    )
    environment._client.conversations.items = items
    return agent, environment


@patch.object(native_agent, "INGEST_POLL_SECONDS", 0)
class NativeRunTest(unittest.IsolatedAsyncioTestCase):
    async def test_a_step_is_a_run_and_its_trajectory_comes_from_the_conversation(
        self,
    ) -> None:
        span = _span(1, "Refund order 7", "Refunded.")
        # The first read lands before ingest has caught up.
        items = _Items([], [span], [span])
        agent, environment = _fixture(_handle(), items)
        context = AgentContext()

        await agent.run("Refund order 7", environment, context)

        environment._client.tasks.runs.create.assert_awaited_once_with(
            "task-1", prompt=TaskPrompt(text="Refund order 7")
        )
        self.assertEqual(items.calls, 3)
        written = json.loads((agent.logs_dir / "trajectory.json").read_text())
        self.assertEqual(len(written["steps"]), 2)
        self.assertEqual(context.n_input_tokens, 7)
        self.assertEqual(context.n_output_tokens, 2)

    async def test_a_selected_prompt_replaces_the_harbor_instruction(self) -> None:
        agent, environment = _fixture(_handle(), _Items([_span(1, "p", "r")]))
        agent._spec = {**SPEC, "input": {"prompt": "counterfactual prompt"}}

        await agent.run("Harbor instruction", environment, AgentContext())

        environment._client.tasks.runs.create.assert_awaited_once_with(
            "task-1", prompt=TaskPrompt(text="counterfactual prompt")
        )

    async def test_the_prompt_template_renders_the_instruction(self) -> None:
        agent, environment = _fixture(_handle(), _Items([_span(1, "p", "r")]))
        template = agent.logs_dir / "template.j2"
        template.write_text("Task: {{ instruction }}")
        agent._prompt_template_path = template

        await agent.run("Refund order 7", environment, AgentContext())

        environment._client.tasks.runs.create.assert_awaited_once_with(
            "task-1", prompt=TaskPrompt(text="Task: Refund order 7")
        )

    async def test_a_run_that_ends_in_error_fails_the_step(self) -> None:
        agent, environment = _fixture(
            _handle(RunErrorEvent(message="provider refused")),
            _Items([_span(1, "go", "partial")]),
        )
        context = AgentContext()
        with self.assertRaisesRegex(NativeRunError, "provider refused"):
            await agent.run("go", environment, context)

        # What the run did before it failed is still the step's evidence.
        self.assertTrue((agent.logs_dir / "trajectory.json").is_file())
        self.assertEqual(context.n_input_tokens, 7)

    async def test_a_failed_run_keeps_its_error_when_the_conversation_is_unreadable(
        self,
    ) -> None:
        agent, environment = _fixture(
            _handle(RunErrorEvent(message="provider refused")), _Items([])
        )
        environment._client.tasks.get = AsyncMock(
            return_value=SimpleNamespace(metadata={})
        )
        context = AgentContext()
        with self.assertRaisesRegex(NativeRunError, "provider refused"):
            await agent.run("go", environment, context)
        self.assertIsNone(context.n_input_tokens)

    async def test_a_step_that_collects_nothing_reports_no_earlier_usage(
        self,
    ) -> None:
        agent, environment = _fixture(_handle(), _Items([_span(1, "go", "done")]))
        await agent.run("go", environment, AgentContext())
        environment._client.tasks.get = AsyncMock(
            return_value=SimpleNamespace(metadata={})
        )
        environment._client.tasks.runs.create = AsyncMock(
            return_value=_handle(RunErrorEvent(message="provider refused"))
        )

        context = AgentContext()
        with self.assertRaises(NativeRunError):
            await agent.resume("again", environment, context)
        agent.populate_context_post_run(context)
        self.assertIsNone(context.n_input_tokens)

    async def test_a_continued_step_is_another_run_on_the_same_task(self) -> None:
        agent, environment = _fixture(_handle(), _Items([_span(1, "go", "done")]))
        await agent.run("first", environment, AgentContext())
        await agent.resume("second", environment, AgentContext())

        self.assertEqual(environment._client.tasks.runs.create.await_count, 2)

    async def test_a_fresh_later_step_is_refused_rather_than_continued(self) -> None:
        agent, environment = _fixture(_handle(), _Items([_span(1, "go", "done")]))
        await agent.run("first", environment, AgentContext())

        with self.assertRaisesRegex(ValueError, "--fresh-steps"):
            await agent.run("second", environment, AgentContext())
        environment._client.tasks.runs.create.assert_awaited_once()

    async def test_harbor_timeout_cancels_the_run_and_keeps_what_finished(
        self,
    ) -> None:
        handle = _handle(block=asyncio.Event())
        agent, environment = _fixture(handle, _Items([_span(1, "go", "partial")]))
        running = asyncio.create_task(agent.run("go", environment, AgentContext()))
        await asyncio.sleep(0.05)

        running.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await running

        handle.cancel.assert_awaited_once()
        self.assertTrue((agent.logs_dir / "trajectory.json").is_file())


class NativeSetupTest(unittest.IsolatedAsyncioTestCase):
    async def test_a_candidate_model_is_refused_rather_than_ignored(self) -> None:
        agent, environment = _fixture(_handle(), _Items([]))
        agent._spec = {**SPEC, "candidate": {**SPEC["candidate"], "model": "gpt-5"}}
        with self.assertRaisesRegex(ValueError, "no per-run override"):
            await agent.setup(environment)

    async def test_a_replay_is_refused_rather_than_run_fresh(self) -> None:
        agent, environment = _fixture(_handle(), _Items([]))
        agent._spec = {**SPEC, "input": {"replay_context_path": "/tmp/replay.json"}}
        with self.assertRaisesRegex(ValueError, "cannot replay"):
            await agent.setup(environment)

    async def test_the_task_mcp_servers_are_bound_in_the_recipe(self) -> None:
        agent, environment = _fixture(_handle(), _Items([]))
        agent.mcp_servers = [
            MCPServerConfig(
                name="crm", transport="streamable-http", url="http://crm:8080/mcp"
            )
        ]
        environment.exec = AsyncMock(return_value=ExecResult(return_code=0))

        await agent.setup(environment)

        command = environment.exec.await_args.args[0]
        self.assertIn(".pi/mcp.local.json", command)
        self.assertIn("http://crm:8080/mcp", command)

    async def test_it_needs_the_environment_that_owns_the_task(self) -> None:
        agent, _ = _fixture(_handle(), _Items([]))
        with self.assertRaisesRegex(TypeError, "Introspection environment"):
            await agent.setup(Mock())


if __name__ == "__main__":
    unittest.main()

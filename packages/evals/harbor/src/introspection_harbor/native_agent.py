"""Harbor adapter that runs each step as a turn of the evaluation task itself.

The other adapters drive Pi through ``exec``, so the platform sees commands
and never a turn: the task carries no prompt and its conversation holds
nothing a judge could read. Here each Harbor step is a run on the trial's own
``kind: eval`` task — the first instruction is its first prompt, every later
step another run on the same task — so the Runtime executes the Recipe exactly
as it does in production, and the trajectory is read back from the
conversation the platform stored.

It needs the Introspection environment, which owns the task; Harbor's
verifier still reaches the sandbox through that environment's commands.
"""

from __future__ import annotations

import asyncio
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, override

from harbor.agents.base import BaseAgent
from harbor.agents.capabilities import AgentCapabilities
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Trajectory
from harbor.utils.templating import render_prompt_template
from harbor.utils.trajectory_utils import compute_model_usage
from introspection_sdk import AsyncRunHandle, IntrospectionAPIError
from introspection_sdk.schemas.agui import RunErrorEvent
from introspection_sdk.schemas.genai_span import GenAiSpan
from introspection_sdk.schemas.tasks import TaskPrompt

from .base import load_run_spec, prepare_recipe_command, selected_prompt
from .credentials import DataPlaneError, platform_call
from .task_environment import IntrospectionEnvironment
from .trajectory import ADAPTER_VERSION, spans_to_trajectory

INGEST_TIMEOUT_ENV = "INTROSPECTION_HARBOR_INGEST_TIMEOUT_SECONDS"
# Spans reach the conversation through the processor's ingest, after the run
# itself has settled. A trial waits this long for them, then reports what
# arrived.
DEFAULT_INGEST_TIMEOUT_SECONDS = 60.0
INGEST_POLL_SECONDS = 3.0
# Between two stream events; a turn that runs a long tool call is quiet.
STREAM_READ_TIMEOUT_SECONDS = 900.0
CONVERSATION_ID_METADATA_KEY = "conversation_id"


class NativeRunError(RuntimeError):
    """The step's run ended in an error the platform reported."""


class IntrospectionNativeAgent(BaseAgent):
    """Run each Harbor step as a run on the trial's evaluation task."""

    # A later step is another run on the same task, whose conversation already
    # holds the earlier ones, so resuming needs nothing replayed.
    capabilities = AgentCapabilities(atif=True, resume=True, mcp_servers=True)

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        template = kwargs.get("prompt_template_path")
        super().__init__(*args, **kwargs)
        self._prompt_template_path = Path(template) if template else None
        self._spec = load_run_spec()
        self._ingest_timeout = float(
            os.environ.get(INGEST_TIMEOUT_ENV, DEFAULT_INGEST_TIMEOUT_SECONDS)
        )
        self._trajectory: Trajectory | None = None
        self._step: Trajectory | None = None
        self._ran = False

    @staticmethod
    @override
    def name() -> str:
        return "introspection-native"

    @override
    def version(self) -> str | None:
        return ADAPTER_VERSION

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        # The Runtime image runs the Recipe itself; there is nothing to install.
        task_environment = _task_environment(environment)
        if model := self._spec["candidate"].get("model"):
            raise ValueError(
                f"the introspection-native agent cannot run the candidate on "
                f"{model!r}: a task run takes the Runtime's own model, with no "
                "per-run override. Drop the model, or use the runtime adapter."
            )
        if (self._spec.get("input") or {}).get("replay_context_path"):
            raise ValueError(
                "the introspection-native agent cannot replay a production "
                "conversation; use the runtime adapter."
            )
        if self.mcp_servers:
            # An eval task's runtime binds the Recipe's `.pi/mcp.local.json`,
            # as the runtime adapter's Pi does.
            result = await task_environment.exec(
                prepare_recipe_command(mcp_servers=self.mcp_servers)
            )
            if result.return_code != 0:
                raise DataPlaneError(
                    f"binding the task's MCP servers failed: {result.stderr}"
                )

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        # Harbor runs a fresh step (`--fresh-steps`) through run() and a
        # continued one through resume(). A task holds one conversation, so a
        # later step here would see the earlier ones.
        if self._ran:
            raise ValueError(
                "the introspection-native agent cannot start a fresh "
                "conversation for a later step: every step is a run on the "
                "trial's one task, whose conversation holds the earlier steps. "
                "Drop --fresh-steps, or use the runtime adapter."
            )
        await self._run_step(instruction, environment, context)

    @override
    async def resume(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        await self._run_step(instruction, environment, context)

    async def _run_step(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        task_environment = _task_environment(environment)
        client = task_environment.client
        task_id = task_environment.task_id
        if self._prompt_template_path:
            instruction = render_prompt_template(
                self._prompt_template_path, instruction
            )
        prompt = selected_prompt(self._spec, instruction)
        started = datetime.now(UTC)
        # A step that collects nothing reports no usage, not the previous step's.
        self._step = None
        with platform_call(f"starting a run on task {task_id}"):
            handle = await client.tasks.runs.create(
                task_id, prompt=TaskPrompt(text=prompt)
            )
        self._ran = True
        try:
            await _settle(handle)
        except asyncio.CancelledError:
            # Harbor's timeout: stop the turn, and keep what it finished.
            await asyncio.shield(
                self._stop_and_collect(handle, task_environment, started)
            )
            raise
        except NativeRunError:
            # The run may have made model calls before it failed: keep them,
            # and fail the step with the run's own error.
            await self._collect_after_failure(task_environment, started)
            self._fill(context)
            raise
        await self._collect(task_environment, started)
        self._fill(context)

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        self._fill(context)

    async def _stop_and_collect(
        self,
        handle: AsyncRunHandle,
        task_environment: IntrospectionEnvironment,
        started: datetime,
    ) -> None:
        try:
            await handle.cancel()
        except IntrospectionAPIError as exc:
            self.logger.warning("run %s not cancelled: %s", handle.run.id, exc)
        await self._collect(task_environment, started)

    async def _collect_after_failure(
        self, task_environment: IntrospectionEnvironment, started: datetime
    ) -> None:
        try:
            await self._collect(task_environment, started)
        except (DataPlaneError, IntrospectionAPIError) as exc:
            self.logger.warning(
                "trajectory of failed task %s not collected: %s",
                task_environment.task_id,
                exc,
            )

    async def _collect(
        self, task_environment: IntrospectionEnvironment, started: datetime
    ) -> None:
        """Read the conversation back and write the trial's trajectory."""

        spans = await self._settled_spans(task_environment, started)
        self._trajectory = spans_to_trajectory(spans)
        if self._trajectory is None:
            return
        step_spans = [span for span in spans if span.start_time >= started]
        self._step = (
            spans_to_trajectory(step_spans)
            if len(step_spans) < len(spans)
            else self._trajectory
        )
        # A continued step's verifier grades the conversation, so the file
        # covers the earlier turns too, as Harbor's own resumable agents write it.
        (self.logs_dir / "trajectory.json").write_text(
            json.dumps(self._trajectory.to_json_dict(), indent=2)
        )

    async def _settled_spans(
        self, task_environment: IntrospectionEnvironment, started: datetime
    ) -> list[GenAiSpan]:
        """The conversation's spans once this step's have stopped arriving.

        Ingest trails the run, so the read repeats until it holds a span from
        this step and two reads agree, or the wait runs out.
        """

        client = task_environment.client
        with platform_call(f"reading task {task_environment.task_id}"):
            task = await client.tasks.get(task_environment.task_id)
        conversation_id = (task.metadata or {}).get(CONVERSATION_ID_METADATA_KEY)
        if not conversation_id:
            raise DataPlaneError(
                f"task {task_environment.task_id} names no conversation"
            )
        deadline = asyncio.get_running_loop().time() + self._ingest_timeout
        previous: list[str] | None = None
        while True:
            with platform_call(f"reading conversation {conversation_id}"):
                spans = [
                    span
                    async for span in client.conversations.items.list(
                        str(conversation_id)
                    )
                ]
            seen = sorted(f"{span.span_id}@{span.start_time}" for span in spans)
            arrived = any(span.start_time >= started for span in spans)
            if (arrived and seen == previous) or (
                asyncio.get_running_loop().time() >= deadline
            ):
                return spans
            previous = seen
            await asyncio.sleep(INGEST_POLL_SECONDS)

    def _fill(self, context: AgentContext) -> None:
        step = self._step
        if step is None:
            return
        context.model_usage = compute_model_usage(step)
        if step.final_metrics:
            context.n_input_tokens = step.final_metrics.total_prompt_tokens
            context.n_output_tokens = step.final_metrics.total_completion_tokens
            context.n_cache_tokens = step.final_metrics.total_cached_tokens
            context.cost_usd = step.final_metrics.total_cost_usd
        context.metadata = {
            "atif": "trajectory.json",
            "introspection": (self._spec.get("input") or {}).get("metadata"),
        }


async def _settle(handle: AsyncRunHandle) -> None:
    """Follow the run's events until it settles; raise if it ended in error."""

    with platform_call(f"following run {handle.run.id}"):
        async for event in handle.stream(timeout=STREAM_READ_TIMEOUT_SECONDS):
            if isinstance(event, RunErrorEvent):
                raise NativeRunError(f"run {handle.run.id} failed: {event.message}")


def _task_environment(environment: BaseEnvironment) -> IntrospectionEnvironment:
    if not isinstance(environment, IntrospectionEnvironment):
        raise TypeError(
            "the introspection-native agent runs on the Introspection "
            f"environment, not {type(environment).__name__}: each step is a run "
            "on the evaluation task that environment creates"
        )
    return environment

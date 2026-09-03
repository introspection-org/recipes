from __future__ import annotations

import asyncio
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import harbor.environments.e2b as harbor_e2b
from harbor.environments.e2b import E2BEnvironment

from introspection_harbor.environment import IntrospectionE2BEnvironment

_OPERATOR_ENV = {
    "E2B_API_KEY": "scoped-e2b-locator",
    "INTROSPECTION_TOKEN": "scoped-session-locator",
    "INTROSPECTION_EGRESS_URL": "http://sandbox-egress:8081",
    "INTROSPECTION_PUBLIC_EGRESS_URL": "https://egress.example.com",
    "INTROSPECTION_PUBLIC_API_URL": "https://dp-api.example.com",
    "INTROSPECTION_PUBLIC_OTEL_URL": "https://otel.example.com",
    "INTROSPECTION_ENDPOINT_HOSTS": "api.e2b.app,api.openai.com",
    "INTROSPECTION_RELAY_TARGET": "local-developer",
}


class IntrospectionE2BEnvironmentTest(unittest.TestCase):
    def test_native_preflight_accepts_bound_e2b_locator(self) -> None:
        with patch.dict(os.environ, _OPERATOR_ENV, clear=True):
            IntrospectionE2BEnvironment.preflight()

    def test_constructor_merges_binding_contract_into_persistent_env(
        self,
    ) -> None:
        with (
            patch.dict(os.environ, _OPERATOR_ENV, clear=True),
            patch.object(E2BEnvironment, "__init__", return_value=None) as init,
        ):
            IntrospectionE2BEnvironment(
                "environment",
                persistent_env={"TASK_SETTING": "value"},
            )

        self.assertEqual(
            init.call_args.kwargs["persistent_env"],
            {
                "TASK_SETTING": "value",
                "INTROSPECTION_TOKEN": "scoped-session-locator",
                "INTROSPECTION_EGRESS_URL": "https://egress.example.com",
                "INTROSPECTION_BASE_API_URL": "https://dp-api.example.com",
                "INTROSPECTION_BASE_OTEL_URL": "https://otel.example.com",
                "INTROSPECTION_SERVICE_NAME": "introspection-eval",
                "INTROSPECTION_ENDPOINT_HOSTS": ("api.e2b.app,api.openai.com"),
                "INTROSPECTION_RELAY_TARGET": "local-developer",
            },
        )
        self.assertNotIn("E2B_API_KEY", init.call_args.kwargs["persistent_env"])
        self.assertNotIn("OPENAI_API_KEY", init.call_args.kwargs["persistent_env"])

    def test_binding_environment_requires_public_egress_contract(self) -> None:
        environment = {
            key: value
            for key, value in _OPERATOR_ENV.items()
            if key != "INTROSPECTION_PUBLIC_EGRESS_URL"
        }
        with (
            patch.dict(os.environ, environment, clear=True),
            patch.object(E2BEnvironment, "__init__", return_value=None),
            self.assertRaisesRegex(ValueError, "INTROSPECTION_PUBLIC_EGRESS_URL"),
        ):
            environment = IntrospectionE2BEnvironment("environment")

    def test_constructor_falls_back_to_native_e2b_without_egress(self) -> None:
        with (
            patch.dict(os.environ, {"E2B_API_KEY": "local-key"}, clear=True),
            patch.object(E2BEnvironment, "__init__", return_value=None) as init,
        ):
            IntrospectionE2BEnvironment(
                "environment",
                persistent_env={"TASK_SETTING": "value"},
            )

        self.assertEqual(
            init.call_args.kwargs["persistent_env"],
            {"TASK_SETTING": "value"},
        )

    def test_constructor_forwards_only_explicitly_allowlisted_environment(self) -> None:
        direct = {
            "E2B_API_KEY": "local-key",
            "ANTHROPIC_API_KEY": "model-key",
            "HELLO_MCP_TOKEN": "mcp-token",
            "INTROSPECTION_HARBOR_PASSTHROUGH_ENV": (
                "ANTHROPIC_API_KEY,HELLO_MCP_TOKEN"
            ),
        }
        with (
            patch.dict(os.environ, direct, clear=True),
            patch.object(E2BEnvironment, "__init__", return_value=None) as init,
        ):
            IntrospectionE2BEnvironment("environment")

        self.assertEqual(
            init.call_args.kwargs["persistent_env"],
            {
                "ANTHROPIC_API_KEY": "model-key",
                "HELLO_MCP_TOKEN": "mcp-token",
            },
        )

    def test_constructor_preserves_harbor_sandbox_timeout_default(self) -> None:
        with (
            patch.dict(os.environ, {"E2B_API_KEY": "local-key"}, clear=True),
            patch.object(E2BEnvironment, "__init__", return_value=None) as init,
        ):
            environment = IntrospectionE2BEnvironment("environment")

        self.assertEqual(environment.sandbox_timeout_seconds, 86_400)
        self.assertNotIn("sandbox_timeout_seconds", init.call_args.kwargs)

    def test_constructor_stores_explicit_sandbox_timeout(self) -> None:
        with (
            patch.dict(os.environ, {"E2B_API_KEY": "local-key"}, clear=True),
            patch.object(E2BEnvironment, "__init__", return_value=None) as init,
        ):
            environment = IntrospectionE2BEnvironment(
                "environment", sandbox_timeout_seconds=3_600
            )

        self.assertEqual(environment.sandbox_timeout_seconds, 3_600)
        self.assertNotIn("sandbox_timeout_seconds", init.call_args.kwargs)

    def test_constructor_selects_external_template_without_forwarding_it(self) -> None:
        with (
            patch.dict(os.environ, {"E2B_API_KEY": "local-key"}, clear=True),
            patch.object(E2BEnvironment, "__init__", return_value=None) as init,
        ):
            environment = IntrospectionE2BEnvironment(
                "environment", template_name="published-template"
            )

        self.assertEqual(environment._template_name, "published-template")
        self.assertNotIn("template_name", init.call_args.kwargs)

    def test_constructor_rejects_nonpositive_timeout(self) -> None:
        with (
            patch.dict(os.environ, {"E2B_API_KEY": "local-key"}, clear=True),
            self.assertRaisesRegex(ValueError, "must be positive"),
        ):
            IntrospectionE2BEnvironment("environment", sandbox_timeout_seconds=0)

    def test_external_template_start_skips_harbor_template_build(self) -> None:
        environment = object.__new__(IntrospectionE2BEnvironment)
        environment.external_template_name = "published-template"
        environment.task_env_config = SimpleNamespace(workdir=None)
        environment._sandbox = Mock()
        environment._create_sandbox = AsyncMock()
        environment.ensure_dirs = AsyncMock()
        environment._mount_targets = Mock(return_value=["/logs"])
        environment._upload_environment_dir_after_start = AsyncMock()

        asyncio.run(environment.start(force_build=True))

        environment._create_sandbox.assert_awaited_once_with()
        environment.ensure_dirs.assert_awaited_once_with(["/logs"])
        environment._upload_environment_dir_after_start.assert_awaited_once_with()
        self.assertEqual(
            environment.task_env_config.workdir,
            "/opt/introspection/recipe",
        )

    def test_external_template_preserves_explicit_task_workdir(self) -> None:
        environment = object.__new__(IntrospectionE2BEnvironment)
        environment.external_template_name = "published-template"
        environment.task_env_config = SimpleNamespace(workdir="/custom/workdir")
        environment._sandbox = Mock()
        environment._create_sandbox = AsyncMock()
        environment.ensure_dirs = AsyncMock()
        environment._mount_targets = Mock(return_value=["/logs"])
        environment._upload_environment_dir_after_start = AsyncMock()

        asyncio.run(environment.start(force_build=True))

        self.assertEqual(environment.task_env_config.workdir, "/custom/workdir")

    def test_sandbox_shim_uses_external_template_and_timeout(self) -> None:
        environment = object.__new__(IntrospectionE2BEnvironment)
        environment._template_name = "published-template"
        environment.environment_name = "hello-mcp"
        environment.session_id = "session"
        environment.sandbox_timeout_seconds = 3_600
        environment._startup_env = Mock(return_value={"TOKEN": "value"})
        environment._network_policy = Mock(network_mode=harbor_e2b.NetworkMode.PUBLIC)
        environment._sandbox_create_network_options = Mock(return_value=None)

        with patch.object(
            harbor_e2b.AsyncSandbox,
            "create",
            new=AsyncMock(return_value=Mock()),
        ) as create:
            asyncio.run(environment._create_sandbox.__wrapped__(environment))

        self.assertEqual(create.await_args.kwargs["template"], "published-template")
        self.assertEqual(create.await_args.kwargs["timeout"], 3_600)

    def test_constructor_rejects_unset_passthrough_environment(self) -> None:
        direct = {
            "E2B_API_KEY": "local-key",
            "INTROSPECTION_HARBOR_PASSTHROUGH_ENV": "MISSING_TOKEN",
        }
        with (
            patch.dict(os.environ, direct, clear=True),
            patch.object(E2BEnvironment, "__init__", return_value=None),
            self.assertRaisesRegex(ValueError, "MISSING_TOKEN"),
        ):
            IntrospectionE2BEnvironment("environment")

    def test_e2b_lifecycle_methods_are_not_overridden(self) -> None:
        for method in (
            "preflight",
            "_does_template_exist",
            "_create_template",
            "_startup_env",
        ):
            self.assertNotIn(method, IntrospectionE2BEnvironment.__dict__)

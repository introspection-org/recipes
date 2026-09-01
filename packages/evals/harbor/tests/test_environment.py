from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from harbor.environments.e2b import E2BEnvironment
from introspection_harbor.environment import IntrospectionE2BEnvironment

_OPERATOR_ENV = {
    "E2B_API_KEY": "scoped-e2b-locator",
    "INTROSPECTION_TOKEN": "scoped-session-locator",
    "INTROSPECTION_EGRESS_URL": "http://sandbox-egress:8081",
    "INTROSPECTION_PUBLIC_EGRESS_URL": "https://egress.example.com",
    "INTROSPECTION_ENDPOINT_HOSTS": "api.e2b.app,api.openai.com",
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
                "INTROSPECTION_ENDPOINT_HOSTS": ("api.e2b.app,api.openai.com"),
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
            IntrospectionE2BEnvironment("environment")

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

    def test_e2b_lifecycle_methods_are_not_overridden(self) -> None:
        for method in (
            "preflight",
            "_does_template_exist",
            "_create_template",
            "_create_sandbox",
            "_startup_env",
        ):
            self.assertNotIn(method, IntrospectionE2BEnvironment.__dict__)

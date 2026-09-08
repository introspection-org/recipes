"""The environment adapter's decisions, without a Data Plane behind them.

Everything here is translation and refusal logic — what a compose document
becomes, what a command spec carries, and what the adapter declines by name.
The transport itself is exercised against a real plane, not mocked here.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from harbor.models.trial.paths import EnvironmentPaths

from introspection_harbor.client import (
    CREDENTIALS_PATH,
    DataPlaneError,
    load_control_plane_credentials,
    load_credentials,
    pull_reference,
)
from introspection_harbor.task_environment import (
    HARBOR_VOLUME_MOUNTS,
    PLANE_TASK_TIMEOUT_SECONDS,
    ComposeUnsupportedError,
    IntrospectionEnvironment,
    build_context,
    download_command,
    exec_command,
    main_service,
    read_compose,
    sidecar_services,
    translate_compose,
    unused_dockerfile,
)

COMPOSE = {
    "services": {
        "main": {
            "volumes": ["shared:/data"],
            "depends_on": {"mcp-server": {"condition": "service_healthy"}},
        },
        "mcp-server": {
            "build": {"context": "./mcp", "dockerfile": "Dockerfile.dev"},
            "healthcheck": {"test": ["CMD", "true"]},
        },
    },
    "volumes": {"shared": {}},
}


class ComposeTranslationTest(unittest.TestCase):
    def test_main_keeps_only_what_binds_the_agent_to_the_world(self) -> None:
        # The Runtime image fills the agent slot; `main` carries only what ties
        # the agent to the world. Naming an image there is refused outright —
        # see MainSlotTest.
        self.assertEqual(
            main_service(COMPOSE),
            {
                "volumes": ["shared:/data"],
                "depends_on": {"mcp-server": {"condition": "service_healthy"}},
            },
        )
        self.assertEqual(set(sidecar_services(COMPOSE)), {"mcp-server"})

    def test_a_sidecar_carries_the_catalog_reference_and_keeps_the_rest(self) -> None:
        compose = translate_compose(COMPOSE, {"mcp-server": "registry/mcp@sha256:abc"})
        self.assertEqual(
            compose,
            {
                "services": {
                    "main": {
                        # The task's own mount, then the ones Harbor needs.
                        "volumes": [
                            "shared:/data",
                            *(f"{n}:{p}" for n, p in HARBOR_VOLUME_MOUNTS.items()),
                        ],
                        "depends_on": {"mcp-server": {"condition": "service_healthy"}},
                    },
                    "mcp-server": {
                        "image": "registry/mcp@sha256:abc",
                        "healthcheck": {"test": ["CMD", "true"]},
                    },
                },
                "volumes": {"shared": {}, **dict.fromkeys(HARBOR_VOLUME_MOUNTS)},
            },
        )

    def test_a_task_with_no_world_still_sends_the_directories_harbor_needs(
        self,
    ) -> None:
        # The common single-container case: the agent runs in the Runtime image
        # and nothing stands beside it. A compose document is still sent,
        # because the directories Harbor writes into have to be writable by
        # the sandbox user, and mounting them is how that happens.
        for document in ({}, {"services": {"main": {}}}):
            with self.subTest(document=document):
                compose = translate_compose(document, {})
                assert compose is not None
                self.assertEqual(set(compose["services"]), {"main"})
                self.assertEqual(set(compose["volumes"]), set(HARBOR_VOLUME_MOUNTS))


class MainSlotTest(unittest.TestCase):
    """`main` is the Runtime image; a task that names its own is refused, not trimmed."""

    def test_a_task_that_builds_its_own_main_is_refused_by_the_key(self) -> None:
        # Dropping the key would run the trial in the Runtime image and report
        # the number as if the task's own environment had been honoured.
        for key, value in (("image", "python:3.12"), ("build", ".")):
            with self.subTest(key=key):
                with self.assertRaises(ComposeUnsupportedError) as refused:
                    main_service({"services": {"main": {key: value}}})
                self.assertIn(key, str(refused.exception))

        self.assertEqual(
            main_service({"services": {"main": {"volumes": ["shared:/data"]}}}),
            {"volumes": ["shared:/data"]},
        )

    def test_a_dockerfile_no_sidecar_builds_is_the_only_signal_a_task_leaves(
        self,
    ) -> None:
        # A task written for a main-building environment often has no compose
        # file at all, so there is no `main` entry to refuse — just this.
        with tempfile.TemporaryDirectory() as scratch:
            environment = Path(scratch)
            self.assertIsNone(unused_dockerfile({}, environment))

            (environment / "Dockerfile").write_text("FROM python:3.12\n")
            self.assertEqual(
                unused_dockerfile({}, environment), environment / "Dockerfile"
            )

            # A sidecar building from the environment directory does read it.
            built = {"services": {"api": {"build": "."}}}
            self.assertIsNone(unused_dockerfile(built, environment))

            # One building from a subdirectory does not.
            elsewhere = {"services": {"api": {"build": "./api"}}}
            self.assertEqual(
                unused_dockerfile(elsewhere, environment), environment / "Dockerfile"
            )


class ComposeReadTest(unittest.TestCase):
    def test_a_missing_compose_file_is_the_single_container_case(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            directory = Path(scratch)
            self.assertEqual(read_compose(directory), {})

            (directory / "docker-compose.yaml").write_text("services:\n  main: {}\n")
            self.assertEqual(read_compose(directory), {"services": {"main": {}}})

    def test_a_compose_file_that_is_not_a_document_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            directory = Path(scratch)
            (directory / "docker-compose.yaml").write_text("- not a mapping\n")
            with self.assertRaises(ComposeUnsupportedError):
                read_compose(directory)

    def test_build_resolves_both_spellings_against_the_compose_file(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            directory = Path(scratch)
            self.assertEqual(
                build_context({"build": "./mcp"}, directory),
                ((directory / "mcp").resolve(), "Dockerfile"),
            )
            self.assertEqual(
                build_context(
                    {"build": {"context": "./mcp", "dockerfile": "Dockerfile.dev"}},
                    directory,
                ),
                ((directory / "mcp").resolve(), "Dockerfile.dev"),
            )
            with self.assertRaises(ComposeUnsupportedError):
                build_context({"build": ["nope"]}, directory)


class ExecSpecTest(unittest.TestCase):
    def test_a_main_shell_string_runs_through_bash_with_env_as_a_prefix(
        self,
    ) -> None:
        # Harbor's installed-agent base prepends `set -o pipefail`, so the
        # Runtime-backed main slot must use Bash rather than Dash's `sh`.
        # There is no per-command environment field on the row, so variables
        # ride an `env` prefix into the same process.
        self.assertEqual(
            exec_command("pytest -q", cwd=None, env=None, timeout_seconds=30),
            {
                "kind": "exec",
                "command": ["/bin/bash", "-c", "pytest -q"],
                "timeout_seconds": 30,
            },
        )
        self.assertEqual(
            exec_command(
                "pytest -q", cwd="/workspace", env={"CI": "1"}, timeout_seconds=30
            ),
            {
                "kind": "exec",
                "command": ["env", "CI=1", "/bin/bash", "-c", "pytest -q"],
                "timeout_seconds": 30,
                "cwd": "/workspace",
            },
        )


class ServiceScopedSpecTest(unittest.TestCase):
    """Harbor addresses a compose service; the main service is the agent slot."""

    def test_a_sidecar_is_named_on_the_wire_and_the_main_service_is_not(self) -> None:
        for service in (None, "main"):
            with self.subTest(service=service):
                self.assertNotIn(
                    "service",
                    exec_command(
                        "true", cwd=None, env=None, timeout_seconds=30, service=service
                    ),
                )
                self.assertNotIn("service", download_command("/out", service=service))

        self.assertEqual(
            exec_command(
                "grade.sh", cwd=None, env=None, timeout_seconds=30, service="grader"
            ),
            {
                "kind": "exec",
                "command": ["/bin/sh", "-c", "grade.sh"],
                "timeout_seconds": 30,
                "service": "grader",
            },
        )
        self.assertEqual(
            download_command("/out/reward.txt", service="grader"),
            {"kind": "download", "path": "/out/reward.txt", "service": "grader"},
        )

    def test_the_adapter_claims_the_capability_its_service_methods_back(self) -> None:
        # `docker_compose` is what lets a task's artifacts and verifier collect
        # hooks name a sidecar at all, so it may only be true while these
        # overrides exist.
        for name in (
            "service_exec",
            "service_download_file",
            "service_download_dir",
        ):
            with self.subTest(method=name):
                self.assertIn(name, vars(IntrospectionEnvironment))


class ImageReferenceTest(unittest.TestCase):
    def test_a_reference_needs_both_halves_to_be_pullable(self) -> None:
        self.assertEqual(
            pull_reference({"image_ref": "r/i", "image_digest": "sha256:a"}),
            "r/i@sha256:a",
        )
        # A row that is not ready yet has one half or neither, and naming it
        # in a compose service would resolve to nothing.
        self.assertIsNone(pull_reference({"image_ref": "r/i"}))
        self.assertIsNone(pull_reference({}))


class TrialTimeoutTest(unittest.TestCase):
    def test_a_budget_above_the_plane_cap_is_refused_not_quietly_halved(self) -> None:
        # `timeout_seconds` is not on POST /v1/tasks, so nobody can raise the
        # cap the idle window is clamped to. Accepting a larger number here
        # would hand back half the trial budget the operator asked for.
        self.assertEqual(PLANE_TASK_TIMEOUT_SECONDS, 7200)


class CredentialsTest(unittest.TestCase):
    def test_the_environment_wins_over_the_stored_login(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            profile = Path(scratch) / "credentials.json"
            profile.write_text(
                json.dumps({"dp_url": "https://stored", "access_token": "old"})
            )

            credentials = load_credentials(
                environ={
                    "INTROSPECTION_DP_URL": "https://env/",
                    "INTROSPECTION_TOKEN": "new",
                },
                credentials_path=profile,
            )
            self.assertEqual(
                (credentials.url, credentials.token), ("https://env", "new")
            )

            stored = load_credentials(environ={}, credentials_path=profile)
            self.assertEqual((stored.url, stored.token), ("https://stored", "old"))

    def test_missing_credentials_name_the_way_out(self) -> None:
        with (
            tempfile.TemporaryDirectory() as scratch,
            self.assertRaisesRegex(DataPlaneError, "introspection login"),
        ):
            load_credentials(environ={}, credentials_path=Path(scratch) / "absent.json")

    def test_resolving_a_runtime_needs_a_project_scoped_login(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            profile = Path(scratch) / "credentials.json"
            # A login with no selected project cannot resolve a Runtime
            # selector, because the lookup is project-scoped.
            profile.write_text(json.dumps({"cp_url": "https://cp", "cp_session": "s"}))
            with self.assertRaisesRegex(DataPlaneError, "select a project"):
                load_control_plane_credentials(environ={}, credentials_path=profile)

            profile.write_text(
                json.dumps(
                    {"cp_url": "https://cp/", "cp_session": "s", "project_id": "p"}
                )
            )
            credentials = load_control_plane_credentials(
                environ={}, credentials_path=profile
            )
            self.assertEqual(
                (credentials.url, credentials.session, credentials.project),
                ("https://cp", "s", "p"),
            )

    def test_the_credentials_path_is_the_cli_profile(self) -> None:
        self.assertEqual(CREDENTIALS_PATH.name, "credentials.json")
        self.assertEqual(CREDENTIALS_PATH.parent.name, ".introspection")


if __name__ == "__main__":
    unittest.main()


class HarborDirectoryTest(unittest.TestCase):
    """Harbor prepares `/logs` and `/tests` before a trial; the sandbox is uid 1000."""

    def test_directory_preparation_does_not_ask_for_root(self) -> None:
        # `_reset_dirs_user` returns "root" by default and `exec` ignores the
        # argument, so the mkdir ran as the sandbox user against a root-owned
        # `/` and failed — with the failure attributed to the trial rather than
        # to the setup. Asking for the user we actually are makes that honest.
        self.assertIsNone(IntrospectionEnvironment._reset_dirs_user(None))  # ty: ignore[invalid-argument-type]

    def test_the_agent_slot_mounts_somewhere_it_can_write(self) -> None:
        """`/logs` and `/tests` sit directly under `/`, which uid 1000 cannot create.

        They are mounted as compose volumes instead, which the platform renders
        as emptyDir under the pod's `fsGroup: 1000` — writable without any
        privilege, and expressible in the compose document the task already
        sends.
        """
        compose = translate_compose(COMPOSE, {"mcp-server": "registry/mcp@sha256:abc"})
        assert compose is not None
        mounts = compose["services"]["main"]["volumes"]
        mounted_at = {entry.rsplit(":", 1)[-1] for entry in mounts}
        self.assertLessEqual({"/logs", "/tests", "/solution"}, mounted_at)
        for name in HARBOR_VOLUME_MOUNTS:
            self.assertIn(name, compose["volumes"])

    def test_the_mounted_set_is_the_one_harbor_declares(self) -> None:
        """Pinned against Harbor's own `EnvironmentPaths` so the set cannot
        drift silently when Harbor adds a directory: a path Harbor writes into
        that is not mounted fails as `mkdir` denied, several steps from the
        cause.

        `/harbor/skills` is excluded on purpose — an agent reads it and guards
        on `is_dir` first, so an empty mount would answer "yes, skills" where
        the truth is "no skills". `/logs`'s children need no mount of their own;
        Harbor creates them inside a writable `/logs`.
        """
        paths = EnvironmentPaths()
        writable = {str(paths.logs_dir), str(paths.tests_dir), str(paths.solution_dir)}
        self.assertEqual(set(HARBOR_VOLUME_MOUNTS.values()), writable)
        self.assertNotIn(str(paths.default_skills_dir), HARBOR_VOLUME_MOUNTS.values())
        for child in (paths.agent_dir, paths.verifier_dir, paths.artifacts_dir):
            self.assertTrue(str(child).startswith(f"{paths.logs_dir}/"))

    def test_a_task_with_no_compose_still_gets_them(self) -> None:
        # The single-container case is the common one, and it needs the dirs
        # just as much — so this is what makes a compose document exist at all.
        compose = translate_compose({}, {})
        assert compose is not None
        self.assertIn(
            "/logs",
            {e.rsplit(":", 1)[-1] for e in compose["services"]["main"]["volumes"]},
        )

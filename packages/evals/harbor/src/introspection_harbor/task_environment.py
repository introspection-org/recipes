"""The Harbor environment backed by an Introspection evaluation task.

Harbor keeps ownership of the trial. This adapter only supplies the sandbox:
``start`` creates a ``kind: eval`` task whose ``compose`` is the task's own
``docker-compose.yaml``, and every ``exec`` / ``upload`` / ``download`` Harbor
asks for afterwards becomes a row on ``POST /v1/tasks/{id}/commands`` that the
task workflow runs inside that sandbox. Every call goes through
``introspection-sdk``.

The consequence worth stating: because the verifier runs through the same
channel, in the same sandbox the agent worked in, a Harbor task's own
``tests/test.sh`` produces the reward. The task adapter cannot do that — it
leaves the Harbor environment idle and substitutes our judges — which is why
this is the adapter for running an arbitrary Harbor job.

``main`` is the agent slot and the Runtime image fills it, so a ``main``
service may carry only what binds the agent to the world (``volumes`` and
``depends_on``); every other service is a sidecar and needs an image the
plane itself produced. See introspection-cloud ``docs/design/eval-task-sidecars.md``.
"""

from __future__ import annotations

import asyncio
import os
import shlex
import tempfile
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, override
from uuid import UUID, uuid4

import yaml
from harbor.constants import MAIN_SERVICE_NAME
from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.environments.capabilities import EnvironmentCapabilities
from harbor.environments.definition import COMPOSE_FILE_NAME, effective_exec_cwd
from harbor.environments.tar_transfer import (
    extract_dir_from_file,
    pack_dir_to_file,
    remote_pack_command,
)
from harbor.models.trial.paths import EnvironmentPaths
from introspection_sdk import AsyncIntrospectionClient, IntrospectionAPIError
from introspection_sdk.schemas.images import (
    ContextImageSource,
    Image,
    ImageProvenance,
    MirrorImageSource,
)
from introspection_sdk.schemas.task_commands import (
    DownloadCommand,
    ExecCommand,
    TaskCommand,
    UploadCommand,
)
from introspection_sdk.schemas.tasks import Task

from .base import (
    MANAGED_PROVIDER_KEYS,
    PROXY_KEY_ENV,
    SESSION_TOKEN_ENV,
    is_runtime_id,
    load_run_spec,
)
from .credentials import (
    LOGIN_KEEPALIVE_ENV,
    TRANSFER_PURPOSE,
    ControlPlaneCredentials,
    DataPlaneError,
    ProfileCredentials,
    client_from_profile,
    load_control_plane_credentials,
    load_credentials,
    platform_call,
)

ENVIRONMENT_TYPE = "introspection"
TASK_KIND = "eval"
TASK_TAG = "harbor"
# `introspection eval run --agent harbor:<name>` records the run spec's agent
# with this prefix: one of Harbor's own agents (`oracle`, `nop`) drives the
# trial, no Recipe agent runs, and the task keeps the Recipe's default.
HARBOR_AGENT_PREFIX = "harbor:"
# The keys a `main` service may carry: it names the agent slot, which the
# Runtime image fills, so anything describing an image is not ours to honour.
MAIN_SERVICE_KEYS = frozenset({"volumes", "depends_on"})
# Task statuses that accept commands. A trial that has not reached one of
# these is not ready for Harbor to drive.
TASK_COMMAND_READY_STATUSES = frozenset({"running", "awaiting_user", "idle"})
TASK_TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled"})
# Before the sandbox exists. A trial sits here while the org's `eval` vqueue
# lane admits it, which is a wait to be patient about, not an error.
ADMISSION_STATUSES = frozenset({"pending", "queued", "scheduled"})
IMAGE_READY_STATUS = "ready"
IMAGE_TERMINAL_STATUSES = frozenset({"ready", "failed", "cancelled", "evicted"})

TRIAL_TIMEOUT_ENV = "INTROSPECTION_HARBOR_TRIAL_TIMEOUT_SECONDS"
START_TIMEOUT_ENV = "INTROSPECTION_HARBOR_START_TIMEOUT_SECONDS"
IMAGE_TIMEOUT_ENV = "INTROSPECTION_HARBOR_IMAGE_TIMEOUT_SECONDS"
EXEC_TIMEOUT_ENV = "INTROSPECTION_HARBOR_EXEC_TIMEOUT_SECONDS"
SANDBOX_PROVIDER_ENV = "INTROSPECTION_HARBOR_SANDBOX_PROVIDER"
TASK_ENVIRONMENT_ENV = "INTROSPECTION_HARBOR_TASK_ENVIRONMENT"
DEFAULT_TASK_ENVIRONMENT = "production"

# The sandbox's wall-clock ceiling, as `idle_timeout_seconds` on the task.
# The plane clamps that to the task's own `timeout_seconds` (7200 by default),
# so a ceiling above it is silently the smaller number.
# It has to cover the WHOLE trial, not just the wait for the first command:
# commands reach the sandbox through `pods/exec`, which the runtime agent
# never sees, so its reported idle seconds climb for the entire trial however
# busy Harbor is. That makes this a ceiling rather than a grace period —
# deliberately, since it is also what releases the sandbox of a wedged trial.
DEFAULT_TRIAL_TIMEOUT_SECONDS = 3600
# The plane's own cap on a task, and the ceiling `idle_timeout_seconds` is
# clamped to. `timeout_seconds` is not on `POST /v1/tasks` — it lives on the
# internal workflow request at this fixed default — so a caller cannot raise
# it, and a trial longer than this cannot be expressed at all. Refused rather
# than clamped: silently halving a configured budget is the failure this whole
# note exists to prevent.
PLANE_TASK_TIMEOUT_SECONDS = 7200
# Admission is queued per org on the `eval` lane, so a trial can wait behind
# others before its sandbox exists. Generous for that reason.
DEFAULT_START_TIMEOUT_SECONDS = 3600.0
DEFAULT_IMAGE_TIMEOUT_SECONDS = 1800.0
DEFAULT_EXEC_TIMEOUT_SECONDS = 900
POLL_SECONDS = 3.0
# Keep each held read below the shortest proxy request timeout on the path.
COMMAND_WAIT_SLICE_SECONDS = 20
TRANSFER_DIR = "/tmp"

# Harbor runs in the parent Operator task. Its agent adapter and a task's
# ``*.env`` interpolation can therefore put parent credentials in a per-command
# variable. An Introspection evaluation task owns its credential environment:
# both managed-provider and BYOK modes put the child's session locator in these
# variables, and egress resolves it to the effective provider credential.
# Passing any parent override would shadow that child contract for the process.
CHILD_OWNED_CREDENTIAL_ENV = frozenset(
    {
        SESSION_TOKEN_ENV,
        PROXY_KEY_ENV,
        *MANAGED_PROVIDER_KEYS.values(),
    }
)

# Harbor writes evidence into these (`EnvironmentPaths`: /logs and its
# agent/verifier/artifacts children, /tests), and `start` creates the /logs
# children Harbor would mount on a mounted provider.
# They sit directly under `/`, which is root-owned in any image, and the
# sandbox runs as uid 1000 with no way to become root — so they are mounted as
# compose named volumes, which the platform renders as emptyDir under the pod's
# `fsGroup: 1000`. Writable without any privilege, and said in the document the
# task already sends rather than in a pod spec that would have to know Harbor.
HARBOR_VOLUME_MOUNTS: dict[str, str] = {
    "harbor-logs": "/logs",
    "harbor-tests": "/tests",
    # The OracleAgent's, and only its. Mounted anyway because validating a task
    # by running its own reference solution is a normal thing to do, and the
    # failure without it is `mkdir /solution` denied rather than anything that
    # names the oracle.
    "harbor-solution": "/solution",
}

# A verifier that calls a model (Harbor's LLM-judge pattern) holds the child's
# session locator, not a provider key, and egress swaps the locator only on a
# plain-HTTP request it can read. An SDK's default `https://` base URL sends
# the locator straight to the provider, which answers 401. These are the base
# URLs each SDK and LiteLLM read, in the plain-HTTP form egress rewrites.
VERIFIER_PROVIDER_BASE_URLS: dict[str, str] = {
    "OPENAI_BASE_URL": "http://api.openai.com/v1",
    "OPENAI_API_BASE": "http://api.openai.com/v1",
    "ANTHROPIC_BASE_URL": "http://api.anthropic.com",
    "ANTHROPIC_API_BASE": "http://api.anthropic.com",
}
CHILD_EGRESS_URL_ENV = "INTROSPECTION_EGRESS_URL"
# A proxy-native runtime reaches every host through `HTTPS_PROXY`, and the
# egress swaps a credential placeholder inside the tunnel, so nothing is rewritten.
CHILD_EGRESS_PROXY_NATIVE_ENV = "INTROSPECTION_EGRESS_PROXY_NATIVE"


def is_verifier_command(command: str) -> bool:
    """Whether Harbor's Verifier built this command.

    The Verifier runs the task's test script by its path under `/tests`, in a
    subshell whose output it redirects, and nothing else execs from there.
    That is the only mark it leaves: the environment is not told which phase a
    command belongs to.
    """

    tests_dir = EnvironmentPaths().tests_dir.as_posix()
    return command.lstrip("('\" ").startswith(f"{tests_dir}/")


def verifier_egress_command(command: str) -> str:
    """Route the verifier's model calls through managed egress.

    The egress URL exists only in the child sandbox, so the shell resolves it
    there. The base URLs and the proxy are set together or not at all: a
    plain-HTTP base URL without the proxy would put the locator on the wire.
    A base URL the task set itself in `[verifier.env]` is left alone. A
    proxy-native child is left alone entirely.
    """

    egress = f"${CHILD_EGRESS_URL_ENV}"
    exports = " ".join(
        f'{name}="${{{name}:-{url}}}"'
        for name, url in VERIFIER_PROVIDER_BASE_URLS.items()
    )
    native = f"${{{CHILD_EGRESS_PROXY_NATIVE_ENV}:-}}"
    return (
        f'if [ -n "${{{CHILD_EGRESS_URL_ENV}:-}}" ] && '
        f'[ "{native}" != 1 ] && [ "{native}" != true ]; then '
        f'export HTTP_PROXY="{egress}" http_proxy="{egress}" {exports}; '
        f"fi; {command}"
    )


def _remote_unpack_command(archive_path: str, target_dir: str) -> str:
    """Extract children into a mounted directory without touching its metadata."""
    # Harbor's packer roots every member at `.`; strip only that synthetic root
    # so tar skips its metadata instead of applying it to the mounted target.
    return (
        f"mkdir -p {shlex.quote(target_dir)} && "
        f"tar --no-overwrite-dir --strip-components=1 "
        f"-xzf {shlex.quote(archive_path)} "
        f"-C {shlex.quote(target_dir)}"
    )


# `EnvironmentPaths.default_skills_dir` (/harbor/skills) is deliberately NOT
# mounted. It is a source an agent reads, not a destination Harbor writes, and
# every agent that reads it guards on `is_dir` first — so an empty mount there
# would answer "yes, skills" where the truth is "no skills", which is worse
# than the directory being absent. Only the agents that inject skills use it,
# and this environment runs the Recipe's own.


class ComposeUnsupportedError(RuntimeError):
    """A compose document the sandbox cannot honour.

    Refused by name rather than dropped: a service that silently does not
    start is a trial that fails for a reason nobody can see.
    """


def read_compose(environment_dir: Path) -> dict[str, Any]:
    """The task's own compose document, or an empty one when it has none.

    A task with no compose file is the common single-container case: the agent
    runs in the Runtime image and nothing else needs to exist.
    """

    path = Path(environment_dir) / COMPOSE_FILE_NAME
    if not path.exists():
        return {}
    document = yaml.safe_load(path.read_text()) or {}
    if not isinstance(document, dict):
        raise ComposeUnsupportedError(f"{path} is not a compose document")
    return document


def main_service(document: dict[str, Any]) -> dict[str, Any]:
    """The `main` service, refusing anything that would name a different image.

    `main` is the agent slot and the Runtime image fills it — the agent base
    plus the Recipe, either baked or materialized from git. A task that
    declares its own `image:` or `build:` there was written for an
    environment that builds main itself; honouring only the keys we support
    and dropping the rest would run the trial in an image the task did not
    ask for and report the result as if it had.
    """

    declared = (document.get("services") or {}).get(MAIN_SERVICE_NAME) or {}
    if unsupported := sorted(set(declared) - MAIN_SERVICE_KEYS):
        raise ComposeUnsupportedError(
            f"services.{MAIN_SERVICE_NAME} declares "
            f"{', '.join(unsupported)}; this environment supplies "
            f"{MAIN_SERVICE_NAME} from the Runtime image, so only "
            f"{', '.join(sorted(MAIN_SERVICE_KEYS))} bind it to the world. "
            "What the agent and the eval logic need belongs in the Recipe; "
            "anything else belongs in a service of its own."
        )
    return {key: declared[key] for key in MAIN_SERVICE_KEYS if key in declared}


def unused_dockerfile(document: dict[str, Any], environment_dir: Path) -> Path | None:
    """A task Dockerfile nothing here will build, or None.

    A task written for an environment that builds its own `main` supplies it
    from `environment/Dockerfile`. That file is not read here, and a task
    with no compose file at all has no `main` entry to refuse, so this is the
    only signal that a task expects an environment this one is not. The
    legitimate case is a sidecar whose build context IS the environment
    directory, which does build it.
    """

    path = Path(environment_dir) / "Dockerfile"
    if not path.exists():
        return None
    root = Path(environment_dir).resolve()
    for service in sidecar_services(document).values():
        if "build" not in service:
            continue
        context, dockerfile = build_context(service, environment_dir)
        if context == root and dockerfile == "Dockerfile":
            return None
    return path


class RuntimeResolver:
    """Resolves a Runtime selector to a version, through the Control Plane."""

    def __init__(
        self, client: AsyncIntrospectionClient, control_plane: ControlPlaneCredentials
    ) -> None:
        self._client = client
        self._project = control_plane.project

    async def resolve_runtime(self, runtime: str, environment: str) -> str:
        """The deployed Runtime version active for *runtime* in *environment*."""

        with platform_call(f"resolving runtime {runtime!r}"):
            page = await self._client.runtimes.list(
                project=self._project, runtime=runtime, environment=environment, limit=1
            )
        if not page.records:
            raise DataPlaneError(
                f"Runtime {runtime!r} has no active version in {environment}"
            )
        return str(page.records[0].id)


async def trial_runtime_id(
    spec: dict[str, Any],
    control_plane: Callable[[], RuntimeResolver],
    environment: str,
) -> str:
    """Return the immutable Runtime version this trial records and starts.

    UUID selectors pin an exact version and touch no Control Plane, so a trial
    pinned that way needs no login. Slugs retain environment-lane resolution,
    which builds the Control Plane client and so reads the login.
    """

    runtime = str(spec["candidate"]["runtime"])
    if is_runtime_id(runtime):
        return runtime
    return await control_plane().resolve_runtime(runtime, environment)


def sidecar_services(document: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Every service that is not the agent slot."""

    services = document.get("services") or {}
    return {
        name: service or {}
        for name, service in services.items()
        if name != MAIN_SERVICE_NAME
    }


def build_context(service: dict[str, Any], environment_dir: Path) -> tuple[Path, str]:
    """The context directory and Dockerfile path a `build:` key names.

    Compose allows the short string form and the long mapping form; both
    resolve relative to the compose file.
    """

    build = service.get("build")
    if isinstance(build, str):
        return (Path(environment_dir) / build).resolve(), "Dockerfile"
    if isinstance(build, dict):
        context = build.get("context", ".")
        dockerfile = build.get("dockerfile", "Dockerfile")
        return (Path(environment_dir) / context).resolve(), dockerfile
    raise ComposeUnsupportedError(f"unsupported build value {build!r}")


def translate_compose(
    document: dict[str, Any],
    references: dict[str, str],
) -> dict[str, Any] | None:
    """The task's `compose` body, or None when the trial needs no sidecars.

    ``references`` maps each sidecar service to the catalog reference resolved
    for it, so this stays a pure rewrite of the document.
    """

    sidecars = sidecar_services(document)
    main = dict(main_service(document))
    # Always sent, even for a task with no compose of its own: Harbor needs
    # these directories on every trial, and the volumes are how they become
    # writable by the sandbox user.
    main["volumes"] = [
        *main.get("volumes", []),
        *(f"{name}:{path}" for name, path in HARBOR_VOLUME_MOUNTS.items()),
    ]

    services: dict[str, Any] = {MAIN_SERVICE_NAME: main}
    for name, service in sidecars.items():
        translated = {
            key: value
            for key, value in service.items()
            if key not in {"build", "image"}
        }
        translated["image"] = references[name]
        services[name] = translated

    compose: dict[str, Any] = {"services": services}
    compose["volumes"] = {
        **(document.get("volumes") or {}),
        **{name: None for name in HARBOR_VOLUME_MOUNTS},
    }
    return compose


def exec_command(
    command: str,
    *,
    cwd: str | None,
    env: dict[str, str] | None,
    timeout_seconds: int,
    service: str | None = None,
) -> ExecCommand:
    """The exec spec for a Harbor shell command.

    Harbor hands over a shell string. The Runtime-backed main slot uses Bash:
    Harbor's installed-agent base prepends ``set -o pipefail``, which POSIX
    ``sh`` implementations such as Dash reject. Sidecars remain on ``sh``
    because they are arbitrary images that may not contain Bash. Per-command
    environment has no server-side field, and is applied here as an ``env``
    prefix. ``service`` names one of the task's own compose services; the main
    service is the agent slot and is left off the wire.
    """

    shell = (
        "/bin/sh"
        if service is not None and service != MAIN_SERVICE_NAME
        else "/bin/bash"
    )
    argv = [shell, "-c", command]
    if env:
        argv = ["env", *(f"{key}={value}" for key, value in env.items()), *argv]
    return ExecCommand(
        command=argv,
        timeout_seconds=timeout_seconds,
        cwd=cwd or None,
        service=_sidecar(service),
    )


def download_command(path: str, *, service: str | None = None) -> DownloadCommand:
    """The download spec for one file, optionally out of a compose sidecar."""

    return DownloadCommand(path=path, service=_sidecar(service))


def _sidecar(service: str | None) -> str | None:
    return None if service == MAIN_SERVICE_NAME else service


def _env_number[N: (int, float)](name: str, default: N) -> N:
    """The number ``name`` sets in the environment, parsed as ``default``'s type."""
    return type(default)(os.environ.get(name, default))


class IntrospectionEnvironment(BaseEnvironment):
    """A Harbor environment whose sandbox is an Introspection evaluation task."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._spec = load_run_spec()
        self._credentials: ProfileCredentials | None = None
        self._client: AsyncIntrospectionClient | None = None
        self._control_plane: RuntimeResolver | None = None
        self._task_id: str | None = None
        self._task_environment = os.environ.get(
            TASK_ENVIRONMENT_ENV, DEFAULT_TASK_ENVIRONMENT
        )
        self._start_timeout = _env_number(
            START_TIMEOUT_ENV, DEFAULT_START_TIMEOUT_SECONDS
        )
        self._image_timeout = _env_number(
            IMAGE_TIMEOUT_ENV, DEFAULT_IMAGE_TIMEOUT_SECONDS
        )
        self._exec_timeout = _env_number(EXEC_TIMEOUT_ENV, DEFAULT_EXEC_TIMEOUT_SECONDS)
        self._trial_timeout = _env_number(
            TRIAL_TIMEOUT_ENV, DEFAULT_TRIAL_TIMEOUT_SECONDS
        )
        if self._trial_timeout > PLANE_TASK_TIMEOUT_SECONDS:
            raise ComposeUnsupportedError(
                f"{TRIAL_TIMEOUT_ENV}={self._trial_timeout} exceeds the plane's own "
                f"{PLANE_TASK_TIMEOUT_SECONDS}s cap on a task, which clamps it. "
                "A trial longer than that cap cannot be expressed today."
            )

    @staticmethod
    @override
    def type() -> str:
        return ENVIRONMENT_TYPE

    @property
    @override
    def capabilities(self) -> EnvironmentCapabilities:
        # `dynamic_network_policy` is false because the sandbox NetworkPolicy
        # is fixed when the pod is created; the base class turns a mid-trial
        # switch into a clear error on the strength of it. `docker_compose` is
        # what gates a task whose artifacts or verifier collect hooks name a
        # sidecar: `service_exec` and `service_download_file` carry those, and
        # the dir walks are generic over the pair. `stop_service` is not — a
        # pod's containers stop together — so the one caller's warning stands,
        # and sidecar evidence is collected with the agent still running.
        return EnvironmentCapabilities(
            gpus=False,
            tpus=False,
            disable_internet=False,
            dynamic_network_policy=False,
            docker_compose=True,
            mounted=False,
        )

    @override
    def _reset_dirs_user(self) -> str | None:
        """The sandbox user, not root.

        The base class asks for root so its `chmod` means something. This
        sandbox runs as uid 1000 and offers no way to become root, so asking
        for root produced a request `exec` silently ignored and a `mkdir` that
        failed against a root-owned `/` — reported as the trial failing rather
        than as the setup never having run. The directories it prepares are
        mounted writable instead (`HARBOR_VOLUME_MOUNTS`).
        """

        return None

    def _merge_env(self, env: dict[str, str] | None) -> dict[str, str] | None:
        """Keep the child task's credential environment authoritative.

        Harbor itself runs inside the parent Operator task. Provider variables
        may arrive from the Recipe agent adapter or Harbor's task-env
        interpolation. An Introspection evaluation sandbox already has its own
        child locator in managed and BYOK modes, so omit every credential
        override and let the command inherit the child's values. Raw BYOK
        secrets belong behind egress and must not cross this task boundary.
        """

        merged = super()._merge_env(env)
        if not merged:
            return merged
        filtered = {
            name: value
            for name, value in merged.items()
            if name not in CHILD_OWNED_CREDENTIAL_ENV
        }
        return filtered or None

    @override
    def _validate_definition(self) -> None:
        # The Runtime image is the environment definition: a task needs no
        # Dockerfile of its own, and a compose file is only read for sidecars.
        document = read_compose(self.environment_dir)
        main_service(document)
        if orphan := unused_dockerfile(document, self.environment_dir):
            raise ComposeUnsupportedError(
                f"{orphan} builds nothing here: this environment supplies "
                f"{MAIN_SERVICE_NAME} from the Runtime image (the agent base "
                "plus the Recipe), so a task that builds its own main image "
                "would run against an environment it did not ask for. Move "
                "what it installs into the Recipe, or give it a service of "
                "its own to build as a sidecar."
            )

    @property
    def task_id(self) -> str:
        if self._task_id is None:
            raise DataPlaneError("the environment has not been started")
        return self._task_id

    @property
    def credentials(self) -> ProfileCredentials:
        if self._credentials is None:
            self._credentials = ProfileCredentials(
                load_credentials(), reload=load_credentials
            )
        return self._credentials

    @property
    def client(self) -> AsyncIntrospectionClient:
        """The SDK client every platform call in the trial goes through."""

        if self._client is None:
            try:
                control_plane = load_control_plane_credentials()
            except DataPlaneError:
                # Only a Runtime slug needs it; `control_plane` says so if one does.
                control_plane = None
            self._client = client_from_profile(self.credentials, control_plane)
        return self._client

    @property
    def control_plane(self) -> RuntimeResolver:
        if self._control_plane is None:
            self._control_plane = RuntimeResolver(
                self.client, load_control_plane_credentials()
            )
        return self._control_plane

    # -- lifecycle ---------------------------------------------------------

    async def resolve_images(self, document: dict[str, Any]) -> dict[str, str]:
        """Put every sidecar's image in the catalog and return its reference.

        A compose service may only name an image the plane produced, so a
        `build:` context is uploaded and built and an `image:` is mirrored.
        """

        references: dict[str, str] = {}
        for name, service in sidecar_services(document).items():
            if "build" in service:
                references[name] = await self._build_sidecar(name, service)
            elif reference := service.get("image"):
                references[name] = await self._mirror_sidecar(name, reference)
            else:
                raise ComposeUnsupportedError(
                    f"compose service {name!r} names neither `image` nor `build`"
                )
        return references

    async def _build_sidecar(self, name: str, service: dict[str, Any]) -> str:
        context, dockerfile = build_context(service, self.environment_dir)
        with tempfile.TemporaryDirectory() as scratch:
            archive = Path(scratch) / f"{name}-context.tar.gz"
            pack_dir_to_file(context, archive, compress=True)
            uploaded = await self._upload_transfer(archive)
        try:
            with platform_call(f"building the {name!r} image"):
                image = await self.client.images.create(
                    name=f"{self.environment_name}/{name}",
                    source=ContextImageSource(file_id=uploaded, dockerfile=dockerfile),
                    provenance=ImageProvenance(service=name),
                )
            return await self._await_image(image)
        finally:
            # Only once the build has read it. A later create with the same
            # content dedupes on the catalog row rather than re-reading this.
            await self._delete_transfer(uploaded)

    async def _mirror_sidecar(self, name: str, reference: str) -> str:
        if "@sha256:" not in reference:
            raise ComposeUnsupportedError(
                f"compose service {name!r} names {reference!r}; a mirrored image "
                "must be digest-pinned so the trial is reproducible"
            )
        with platform_call(f"mirroring the {name!r} image"):
            image = await self.client.images.create(
                name=f"{self.environment_name}/{name}",
                source=MirrorImageSource(reference=reference),
                provenance=ImageProvenance(service=name),
            )
        return await self._await_image(image)

    async def _await_image(self, image: Image) -> str:
        deadline = asyncio.get_running_loop().time() + self._image_timeout
        while image.status not in IMAGE_TERMINAL_STATUSES:
            if asyncio.get_running_loop().time() >= deadline:
                raise DataPlaneError(
                    f"image {image.id} did not build within "
                    f"{self._image_timeout:.0f}s (status {image.status!r})"
                )
            await asyncio.sleep(POLL_SECONDS)
            with platform_call(f"reading image {image.id}"):
                image = await self.client.images.get(image.id)

        if image.status != IMAGE_READY_STATUS:
            raise DataPlaneError(
                f"image {image.id} is {image.status!r}: "
                f"{image.error or 'no error recorded'}"
            )
        if not image.pull_reference:
            raise DataPlaneError(f"image {image.id} is ready but has no reference")
        return image.pull_reference

    def create_task_body(
        self,
        runtime_id: str,
        compose: dict[str, Any] | None,
    ) -> dict[str, Any]:
        candidate = self._spec["candidate"]
        metadata: dict[str, Any] = {
            "harbor": {
                "environment": self.type(),
                "trial": self._spec.get("trial"),
            },
        }
        if provider := os.environ.get(SANDBOX_PROVIDER_ENV):
            metadata["sandbox_provider"] = provider
        body: dict[str, Any] = {
            "runtime_id": runtime_id,
            "kind": TASK_KIND,
            "tags": [TASK_TAG],
            "commands": True,
            "idle_timeout_seconds": self._trial_timeout,
            "metadata": metadata,
        }
        if recipe_sha := candidate.get("recipe_git_commit_sha"):
            body["recipe_git_commit_sha"] = recipe_sha
        agent = candidate.get("agent")
        if agent and not agent.startswith(HARBOR_AGENT_PREFIX):
            body["agent_name"] = agent
        if compose is not None:
            body["compose"] = compose
        return body

    def _warn_if_the_login_expires_mid_trial(self) -> None:
        """A trial outlives a short-lived login, and nothing here renews one.

        Refusing would be wrong — a login with an hour left runs most trials
        fine — but a token that dies at minute forty of a sixty-minute trial
        fails whichever command happens to be next, which reads as that
        command failing. `introspection eval run` renews the login for as long
        as the run lasts and says so, which leaves nothing to warn about.
        """

        expires_at = self.credentials.credentials.expires_at
        if expires_at is None or os.environ.get(LOGIN_KEEPALIVE_ENV):
            return
        remaining = expires_at - time.time()
        if remaining < self._trial_timeout:
            self.logger.warning(
                "the stored login expires in %.0fs, inside this trial's %ss ceiling; "
                "run `introspection login` first or the trial may fail partway",
                remaining,
                self._trial_timeout,
            )

    @override
    async def start(self, force_build: bool) -> None:
        self._warn_if_the_login_expires_mid_trial()
        document = read_compose(self.environment_dir)
        runtime_id = await trial_runtime_id(
            self._spec, lambda: self.control_plane, self._task_environment
        )
        references = await self.resolve_images(document)
        compose = translate_compose(document, references)
        with platform_call("creating the trial task"):
            created = await self.client.tasks.create(
                **self.create_task_body(runtime_id, compose)
            )
        self._task_id = str(created.task.id)
        await self._await_ready(created.task)
        await self.ensure_dirs(self._mount_targets(writable_only=True))

    async def _await_ready(self, task: Task) -> None:
        deadline = asyncio.get_running_loop().time() + self._start_timeout
        while task.status not in TASK_COMMAND_READY_STATUSES:
            if task.status in TASK_TERMINAL_STATUSES:
                raise DataPlaneError(
                    f"task {self.task_id} reached {task.status!r} before it "
                    "was ready to accept commands"
                )
            if asyncio.get_running_loop().time() >= deadline:
                waiting = task.status in ADMISSION_STATUSES
                raise DataPlaneError(
                    f"task {self.task_id} was not ready within "
                    f"{self._start_timeout:.0f}s (status {task.status!r})"
                    + (
                        "; it is still waiting for admission on the org's `eval` "
                        "lane. Lower Harbor's --n-concurrent-trials to the org's "
                        f"eval concurrency, or raise {START_TIMEOUT_ENV}."
                        if waiting
                        else ""
                    )
                )
            await asyncio.sleep(POLL_SECONDS)
            with platform_call(f"reading task {self.task_id}"):
                task = await self.client.tasks.get(self.task_id)

    @override
    async def stop(self, delete: bool) -> None:
        try:
            if delete and self._task_id is not None:
                # Archive requests asynchronous teardown while retaining the
                # task for inspection. Best effort: cleanup must not fail an
                # otherwise valid score; the task's ceiling is the fallback.
                try:
                    await self.client.tasks.archive(self._task_id)
                except IntrospectionAPIError as exc:
                    self.logger.debug("task %s not archived: %s", self._task_id, exc)
        finally:
            self._task_id = None
            self._control_plane = None
            if self._client is not None:
                await self._client.shutdown()
                self._client = None

    # -- commands ----------------------------------------------------------

    async def run_command(
        self,
        spec: ExecCommand | UploadCommand | DownloadCommand,
        *,
        budget: float,
    ) -> TaskCommand:
        """Create a command and wait for it, in server-held slices."""

        commands = self.client.tasks.commands
        with platform_call(f"sending a {spec.kind} command"):
            command = await commands.create(self.task_id, spec)
        deadline = asyncio.get_running_loop().time() + budget
        while not command.status.is_terminal:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise DataPlaneError(
                    f"command {command.id} did not finish within {budget:.0f}s "
                    f"(status {command.status!r})"
                )
            with platform_call(f"reading command {command.id}"):
                command = await commands.get(
                    self.task_id,
                    command.id,
                    wait_seconds=int(min(remaining, COMMAND_WAIT_SLICE_SECONDS)),
                )
        return command

    async def _run_exec(
        self,
        command: str,
        *,
        cwd: str | None,
        env: dict[str, str] | None,
        timeout_sec: int | None,
        service: str | None,
    ) -> ExecResult:
        timeout = timeout_sec or self._exec_timeout
        spec = exec_command(
            command, cwd=cwd, env=env, timeout_seconds=timeout, service=service
        )
        # The grace lets the server's own bound fire first, so a command that
        # overruns comes back as a recorded timeout rather than a lost row.
        row = await self.run_command(spec, budget=timeout + POLL_SECONDS * 2)
        if row.status == "failed" and row.exit_code is None:
            raise DataPlaneError(
                f"command {row.id} failed: {row.error or 'no error recorded'}"
            )
        exit_code = row.exit_code
        return ExecResult(
            stdout=row.stdout,
            stderr=row.stderr,
            # A row that reached a terminal state without an exit code did not
            # run at all; a non-zero stand-in keeps that a failure to Harbor.
            return_code=1 if exit_code is None else int(exit_code),
        )

    @override
    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> ExecResult:
        requested = self._resolve_user(user)
        if requested is not None:
            # The sandbox runs every command as its own user and offers no
            # switch. Ignored rather than refused because the base class asks
            # for root on its own housekeeping (`reset_dirs`); a command that
            # genuinely needed the other user fails on its own exit code,
            # which is visible, where refusing here would fail every trial.
            self.logger.debug(
                "introspection sandbox cannot run as %r; using the sandbox user",
                requested,
            )
        if is_verifier_command(command):
            command = verifier_egress_command(command)
        return await self._run_exec(
            command,
            cwd=effective_exec_cwd(cwd, self.task_env_config.workdir, None),
            env=self._merge_env(env),
            timeout_sec=timeout_sec,
            service=None,
        )

    @override
    async def service_exec(
        self,
        command: str,
        *,
        service: str | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> ExecResult:
        if self.is_main_service(service):
            return await self.exec(
                command, cwd=cwd, env=env, timeout_sec=timeout_sec, user=user
            )
        # A sidecar is the world beside the agent, so it inherits none of the
        # agent's workdir, default user or persistent environment — the same
        # split every compose-capable provider makes. The server refuses a
        # service this task did not declare.
        return await self._run_exec(
            command, cwd=cwd, env=env, timeout_sec=timeout_sec, service=service
        )

    # -- transfers ---------------------------------------------------------

    @override
    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        uploaded = await self._upload_transfer(Path(source_path))
        try:
            spec = UploadCommand(file_id=uploaded, path=target_path)
            row = await self.run_command(spec, budget=self._exec_timeout)
            if row.status != "completed":
                raise DataPlaneError(
                    f"upload to {target_path} failed: "
                    f"{row.error or 'no error recorded'}"
                )
        finally:
            # The sandbox has the bytes now; the staged copy is scratch.
            await self._delete_transfer(uploaded)

    async def _download(
        self, source_path: str, target_path: Path | str, *, service: str | None
    ) -> None:
        spec = download_command(source_path, service=service)
        row = await self.run_command(spec, budget=self._exec_timeout)
        file_id = row.output_file_id
        if row.status != "completed" or file_id is None:
            raise DataPlaneError(
                f"download of {source_path} failed: {row.error or 'no error recorded'}"
            )
        try:
            target = Path(target_path)
            target.parent.mkdir(parents=True, exist_ok=True)
            with platform_call(f"downloading file {file_id}"):
                content = await self.client.files.download(str(file_id))
            target.write_bytes(content)
        finally:
            # `download` writes its output through the encrypted store, so this
            # one is not raw — deleting it promptly is all the adapter can do.
            await self._delete_transfer(file_id)

    async def _upload_transfer(self, source: Path) -> UUID:
        """Stage *source* as a transient transfer file and return its id.

        Unencrypted, in the raw blob store the build-context and upload-command
        paths read: machine-generated tars intended for one transfer.
        """

        with platform_call(f"uploading {source.name}"):
            uploaded = await self.client.files.upload(
                file=source,
                name=source.name,
                metadata={"encryption": False, "purpose": TRANSFER_PURPOSE},
            )
        return uploaded.id

    async def _delete_transfer(self, file_id: UUID) -> None:
        """Best effort: Operator lacks `files:delete`, and a trial that failed
        mid-transfer should surface that, not a cleanup error on top."""

        try:
            await self.client.files.delete(str(file_id))
        except IntrospectionAPIError as exc:
            self.logger.debug("transfer file %s not deleted: %s", file_id, exc)

    @override
    async def download_file(self, source_path: str, target_path: Path | str) -> None:
        await self._download(source_path, target_path, service=None)

    @override
    async def service_download_file(
        self,
        source_path: str,
        target_path: Path | str,
        *,
        service: str | None = None,
    ) -> None:
        await self._download(
            source_path,
            target_path,
            service=None if self.is_main_service(service) else service,
        )

    @override
    async def service_download_dir(
        self,
        source_dir: str,
        target_dir: Path | str,
        *,
        service: str | None = None,
    ) -> None:
        if self.is_main_service(service):
            await self.download_dir(source_dir, target_dir)
            return
        # The base class's tar-through-a-file walk, which is written purely in
        # terms of `service_exec` + `service_download_file`.
        await self._download_dir_with_exclusions_impl(
            source_dir=source_dir, target_dir=target_dir, exclude=[], service=service
        )

    @asynccontextmanager
    async def _remote_scratch(self, suffix: str) -> AsyncIterator[str]:
        """A path in the sandbox's transfer dir, removed when the block exits.

        A directory transfer stages a tar of the whole tree inside the
        sandbox. Nothing else reaps it — the pod's scratch lives as long as
        the trial does — so it is removed on the way out, including on the
        failure path. Best effort, like the base class's own tar cleanup: a
        transfer that failed should surface that, not a cleanup error on top.
        The name is unique per transfer so two cannot collide on one trial.
        """

        remote = f"{TRANSFER_DIR}/{uuid4().hex}{suffix}"
        try:
            yield remote
        finally:
            try:
                await self.exec(f"rm -f {shlex.quote(remote)}")
            except DataPlaneError as exc:
                self.logger.warning(
                    "failed to remove transfer file %s: %s", remote, exc
                )

    @override
    async def upload_dir(self, source_dir: Path | str, target_dir: str) -> None:
        """Tar the tree, send it as one file, unpack it in the sandbox.

        A command row carries a bounded output tail rather than bytes, so a
        directory is one transfer plus one exec, never a file at a time.
        """

        async with self._remote_scratch(".tar.gz") as remote:
            with tempfile.TemporaryDirectory() as scratch:
                archive = Path(scratch) / "upload.tar.gz"
                pack_dir_to_file(source_dir, archive, compress=True)
                await self.upload_file(archive, remote)
            result = await self.exec(_remote_unpack_command(remote, target_dir))
            if result.return_code != 0:
                raise DataPlaneError(
                    f"unpacking {remote} into {target_dir} failed: "
                    f"{result.stderr or result.stdout or 'no output'}"
                )

    @override
    async def download_dir(self, source_dir: str, target_dir: Path | str) -> None:
        async with self._remote_scratch(".tar.gz") as remote:
            result = await self.exec(remote_pack_command(source_dir, remote))
            if result.return_code != 0:
                raise DataPlaneError(
                    f"packing {source_dir} failed: "
                    f"{result.stderr or result.stdout or 'no output'}"
                )
            with tempfile.TemporaryDirectory() as scratch:
                archive = Path(scratch) / "download.tar.gz"
                await self.download_file(remote, archive)
                extract_dir_from_file(archive, target_dir)

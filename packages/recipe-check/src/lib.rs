//! Pure validation library for Introspection Recipe packages.
//!
//! The core API is I/O-free: [`check_recipe_files`] takes an in-memory
//! [`RecipeFiles`] snapshot of a recipe directory and returns a [`Report`].
//! Hosts own filesystem discovery and any environment-specific policy.

mod judges;
mod prompts;
pub mod resources;
pub mod spec;
pub mod template;

pub use prompts::{Suggestion, SUGGESTION_PLACEHOLDERS};

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

/// In-memory snapshot of a recipe directory.
///
/// Paths are relative to the recipe root and use `/` separators. Every
/// ancestor of a file path is implicitly a directory; `directories` only
/// needs entries for directories that contain no files.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipeFiles {
    pub files: Vec<RecipeFile>,
    #[serde(default)]
    pub directories: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipeFile {
    pub path: String,
    /// File content, when the host chose to read it. `None` means the file
    /// exists but its content was not supplied; checks that need the content
    /// report it as unreadable.
    pub content: Option<String>,
}

impl RecipeFile {
    pub fn new(path: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            content: Some(content.into()),
        }
    }

    pub fn unread(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            content: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Report {
    pub valid: bool,
    pub diagnostics: Vec<Diagnostic>,
    /// Discovered portable Recipe resources, keyed by resource kind.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub resources: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    #[default]
    Error,
    Warning,
}

impl Severity {
    pub const fn is_error(self) -> bool {
        matches!(self, Self::Error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: String,
    #[serde(default)]
    pub severity: Severity,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span: Option<Span>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
}

/// 1-based source location of a diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub line: usize,
    pub column: usize,
}

type JsonMap = serde_json::Map<String, JsonValue>;

#[derive(Debug, Clone)]
struct Package {
    name: Option<String>,
    version: Option<String>,
    pi: Option<JsonValue>,
    /// `dependencies` entries with a version.
    dependencies: BTreeSet<String>,
    /// Every `dependencies` key, with or without a version.
    dependency_keys: BTreeSet<String>,
    /// `peerDependencies` entries with a version.
    peer_dependencies: BTreeSet<String>,
    /// Every `peerDependencies` key, with or without a version.
    peer_dependency_keys: BTreeSet<String>,
    runtime_dependencies: bool,
    package_manager: Option<String>,
}

#[derive(Debug, Clone)]
struct ResourcePatterns {
    explicit: bool,
    patterns: Vec<String>,
}

#[derive(Debug, Clone)]
struct RawAgent {
    name: String,
    path: String,
    from: Option<String>,
    fields: HashSet<AgentField>,
    skills: Option<Vec<String>>,
    subagents: Option<Vec<String>>,
    tools: Option<Vec<String>>,
    mcp: Option<AgentMcpConfig>,
}

#[derive(Debug, Clone, Default)]
struct McpToolSelectors {
    include: Option<BTreeSet<String>>,
    exclude: Option<BTreeSet<String>>,
    defer: Option<BTreeSet<String>>,
    eager: Option<BTreeSet<String>>,
    /// The tools whose own calls alone may reach the server.
    behind: Option<BTreeSet<String>>,
}

type McpToolPolicy = BTreeMap<String, McpToolSelectors>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentMcpMode {
    Cli,
    Tools,
    Codemode,
}

#[derive(Debug, Clone, Default)]
struct AgentMcpConfig {
    mode: Option<AgentMcpMode>,
    servers: BTreeMap<String, McpToolSelectors>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum AgentField {
    ModelName,
}

impl AgentField {
    const REQUIRED: [Self; 1] = [Self::ModelName];

    const fn label(self) -> &'static str {
        match self {
            Self::ModelName => "model.name",
        }
    }

    const fn help(self) -> Option<&'static str> {
        match self {
            Self::ModelName => Some("set a model or inherit one from a base agent"),
        }
    }
}

struct CheckContext {
    files: BTreeMap<String, Option<String>>,
    directories: BTreeSet<String>,
    diagnostics: Vec<Diagnostic>,
}

impl CheckContext {
    fn new(input: &RecipeFiles) -> Self {
        let mut files = BTreeMap::new();
        let mut directories = BTreeSet::new();
        for file in &input.files {
            let path = normalize_relative(&file.path);
            if path.is_empty() {
                continue;
            }
            for ancestor in ancestor_dirs(&path) {
                directories.insert(ancestor);
            }
            files.insert(path, file.content.clone());
        }
        for directory in &input.directories {
            let path = normalize_relative(directory);
            if path.is_empty() {
                continue;
            }
            for ancestor in ancestor_dirs(&path) {
                directories.insert(ancestor);
            }
            directories.insert(path);
        }
        Self {
            files,
            directories,
            diagnostics: Vec::new(),
        }
    }

    fn has_file(&self, path: &str) -> bool {
        self.files.contains_key(path)
    }

    fn has_dir(&self, path: &str) -> bool {
        self.directories.contains(path)
    }

    fn path_exists(&self, path: &str) -> bool {
        self.has_file(path) || self.has_dir(path)
    }

    fn content(&self, path: &str) -> Option<&str> {
        self.files.get(path).and_then(Option::as_deref)
    }

    /// Files that are direct children of `dir`.
    fn child_files(&self, dir: &str) -> Vec<&str> {
        let prefix = format!("{dir}/");
        self.files
            .range(prefix.clone()..)
            .take_while(|(path, _)| path.starts_with(&prefix))
            .filter(|(path, _)| !path[prefix.len()..].contains('/'))
            .map(|(path, _)| path.as_str())
            .collect()
    }

    /// Directories that are direct children of `dir`.
    fn child_dirs(&self, dir: &str) -> Vec<String> {
        let prefix = format!("{dir}/");
        self.directories
            .range(prefix.clone()..)
            .take_while(|path| path.starts_with(&prefix))
            .filter(|path| !path[prefix.len()..].contains('/'))
            .cloned()
            .collect()
    }

    fn push(
        &mut self,
        code: impl Into<String>,
        severity: Severity,
        path: impl Into<String>,
        span: Option<Span>,
        message: impl Into<String>,
        help: Option<impl Into<String>>,
    ) {
        self.diagnostics.push(Diagnostic {
            code: code.into(),
            severity,
            path: path.into(),
            span,
            message: message.into(),
            help: help.map(Into::into),
        });
    }

    fn error(
        &mut self,
        code: impl Into<String>,
        path: impl Into<String>,
        message: impl Into<String>,
        help: Option<impl Into<String>>,
    ) {
        self.push(code, Severity::Error, path, None, message, help);
    }

    fn warning(
        &mut self,
        code: impl Into<String>,
        path: impl Into<String>,
        message: impl Into<String>,
        help: Option<impl Into<String>>,
    ) {
        self.push(code, Severity::Warning, path, None, message, help);
    }

    fn error_at(
        &mut self,
        code: impl Into<String>,
        path: impl Into<String>,
        span: Option<Span>,
        message: impl Into<String>,
        help: Option<impl Into<String>>,
    ) {
        self.push(code, Severity::Error, path, span, message, help);
    }
}

/// Validate the portable structure of an in-memory Recipe snapshot.
///
/// This function does not apply host, deployment, package-manager, or
/// publication policy.
pub fn check_recipe_files(input: &RecipeFiles) -> Report {
    let mut ctx = CheckContext::new(input);
    let mut resource_counts = BTreeMap::new();

    let package = read_package(&mut ctx);
    if let Some(package) = package {
        validate_package_identity(&package, &mut ctx);
        validate_dependency_package(&package, &mut ctx);
        let resources = validate_pi_config(&package, &mut ctx);
        let declared_mcp_servers: BTreeSet<String> = package
            .pi
            .as_ref()
            .and_then(JsonValue::as_object)
            .and_then(|pi| mcp_tool_policy(pi.get("mcp")))
            .map(|policy| policy.into_keys().collect())
            .unwrap_or_default();
        validate_mcp_local_config(&declared_mcp_servers, &mut ctx);
        validate_mcp_local_example(&mut ctx);

        let mcp_tool_policy = package
            .pi
            .as_ref()
            .and_then(JsonValue::as_object)
            .and_then(|pi| mcp_tool_policy(pi.get("mcp")));
        let dependency_skills = resolve_dependency_skills(&package, &mut ctx);
        let agent_paths = resolve_agents(&resources, &ctx);
        resource_counts.insert("agents".to_owned(), agent_paths.len());
        for key in ["extensions", "skills", "prompts"] {
            if let Some(paths) = resources.get(key) {
                resource_counts.insert(key.to_owned(), paths.len());
            }
        }
        if let Some(paths) = resources.get("prompts") {
            prompts::validate_prompt_templates(paths, &mut ctx);
        }
        validate_agents(
            &agent_paths,
            &resources,
            &dependency_skills,
            mcp_tool_policy.as_ref(),
            &mut ctx,
        );
    }

    let judge_count = judges::validate_judges(&mut ctx);
    if judge_count > 0 {
        resource_counts.insert("judges".to_owned(), judge_count);
    }

    let valid = !ctx
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity.is_error());
    Report {
        valid,
        diagnostics: ctx.diagnostics,
        resources: resource_counts,
    }
}

/// A Recipe's suggestions: the prompt templates its `pi.prompts` (or
/// `prompts/` by convention) selects that are marked `suggest: true`, in file
/// order. Empty when none are marked or the package can't be read; run
/// [`check_recipe_files`] for the reasons.
pub fn list_recipe_suggestions(input: &RecipeFiles) -> Vec<Suggestion> {
    let mut ctx = CheckContext::new(input);
    let Some(package) = read_package(&mut ctx) else {
        return Vec::new();
    };
    let Some(valid) = validate_pi_config(&package, &mut ctx).remove("prompts") else {
        return Vec::new();
    };
    // `valid` is sorted; Pi reads `pi.prompts` in the order it's written
    // (sorted within a glob), and the first template with a name wins.
    let pi = package.pi.as_ref().and_then(JsonValue::as_object);
    let patterns = resource_patterns(
        "prompts",
        pi.and_then(|pi| pi.get("prompts")),
        false,
        &mut ctx,
    );
    let mut ordered: Vec<String> = Vec::new();
    for pattern in &patterns.patterns {
        for path in match_paths(&ctx, pattern) {
            if valid.contains(&path) && !ordered.contains(&path) {
                ordered.push(path);
            }
        }
    }
    prompts::read_suggestions(&ordered, &ctx)
}

const PACKAGE_JSON: &str = "package.json";
const MAX_INHERITANCE_DEPTH: usize = 128;

fn read_package(ctx: &mut CheckContext) -> Option<Package> {
    if !ctx.has_file(PACKAGE_JSON) {
        ctx.error(
            "package.manifest_missing",
            PACKAGE_JSON,
            "Recipe is missing package.json",
            Some("add package.json with a pi object"),
        );
        return None;
    }
    let Some(content) = ctx.content(PACKAGE_JSON).map(str::to_owned) else {
        ctx.error(
            "package.manifest_unreadable",
            PACKAGE_JSON,
            "package.json content was not provided",
            Some("supply package.json content to the validator"),
        );
        return None;
    };

    let parsed: JsonValue = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(err) => {
            let span = Some(Span {
                line: err.line(),
                column: err.column(),
            });
            ctx.error_at(
                "package.manifest_malformed",
                PACKAGE_JSON,
                span,
                format!("package.json is not valid JSON: {err}"),
                Some("fix package.json syntax"),
            );
            return None;
        }
    };

    let Some(object) = parsed.as_object() else {
        ctx.error(
            "package.manifest_invalid",
            PACKAGE_JSON,
            "package.json must be an object",
            Some("make the top-level JSON value an object"),
        );
        return None;
    };

    let pi = object.get("pi").cloned();
    if !matches!(pi.as_ref(), Some(JsonValue::Object(_))) {
        ctx.error(
            "package.pi_missing",
            PACKAGE_JSON,
            "package.json is missing a pi object",
            Some(
                "add package.json#pi; it may be empty when using conventional resource directories",
            ),
        );
    }

    Some(Package {
        name: string_value(object.get("name")),
        version: string_value(object.get("version")),
        pi,
        dependencies: object
            .get("dependencies")
            .and_then(JsonValue::as_object)
            .map(|dependencies| {
                dependencies
                    .iter()
                    .filter_map(|(name, version)| {
                        string_value(Some(version)).map(|_| name.to_owned())
                    })
                    .collect()
            })
            .unwrap_or_default(),
        dependency_keys: object_keys(object.get("dependencies")),
        peer_dependencies: versioned_keys(object.get("peerDependencies")),
        peer_dependency_keys: object_keys(object.get("peerDependencies")),
        runtime_dependencies: has_non_empty_object(object.get("dependencies"))
            || has_non_empty_object(object.get("optionalDependencies")),
        package_manager: string_value(object.get("packageManager")),
    })
}

fn validate_package_identity(package: &Package, ctx: &mut CheckContext) {
    if package.name.is_none() {
        ctx.error(
            "package.name_missing",
            PACKAGE_JSON,
            "Package is missing name",
            Some("set package.json#name to the recipe identifier"),
        );
    }
}

fn validate_dependency_package(package: &Package, ctx: &mut CheckContext) {
    validate_peers(package, ctx);
    if package.runtime_dependencies && !has_dependency_lockfile(ctx) {
        ctx.warning(
            "package.lockfile_missing",
            PACKAGE_JSON,
            "Recipe declares runtime dependencies but has no lockfile",
            Some("commit pnpm-lock.yaml"),
        );
    }

    if let Some(package_manager) = package.package_manager.as_deref() {
        // Corepack refuses to run pnpm when this names another manager, so the
        // documented install aborts before any lockfile rule applies.
        if !is_pnpm_package_manager(package_manager) {
            ctx.error(
                "package.package_manager_not_pnpm",
                PACKAGE_JSON,
                format!("packageManager must be pnpm@<version>, not '{package_manager}'"),
                Some("Corepack rejects a bare name or a partial version; or remove the field"),
            );
        }
    }

    for lockfile in FOREIGN_LOCKFILES {
        if ctx.has_file(lockfile) {
            ctx.error(
                "package.lockfile_not_pnpm",
                lockfile,
                format!("Recipes install with pnpm, so {lockfile} is never read"),
                Some("delete it and commit pnpm-lock.yaml instead"),
            );
        }
    }

    for lockfile in ["package-lock.json", "npm-shrinkwrap.json"] {
        let Some(content) = ctx.content(lockfile).map(str::to_owned) else {
            continue;
        };
        let parsed: JsonValue = match serde_json::from_str(&content) {
            Ok(value) => value,
            Err(err) => {
                ctx.error(
                    "package.lockfile_malformed",
                    lockfile,
                    format!("{lockfile} is not valid JSON: {err}"),
                    Some("regenerate the lockfile from the current package.json"),
                );
                continue;
            }
        };
        let Some(root) = parsed.as_object() else {
            continue;
        };
        let package_root = root
            .get("packages")
            .and_then(JsonValue::as_object)
            .and_then(|packages| packages.get(""))
            .and_then(JsonValue::as_object);
        for (location, entry) in [("top-level", Some(root)), ("packages[\"\"]", package_root)] {
            let Some(entry) = entry else {
                continue;
            };
            for (field, expected) in [
                ("name", package.name.as_deref()),
                ("version", package.version.as_deref()),
            ] {
                if let (Some(expected), Some(actual)) = (expected, string_value(entry.get(field))) {
                    if expected != actual {
                        ctx.error(
                            format!("package.lockfile_{field}_mismatch"),
                            lockfile,
                            format!(
                                "{lockfile} {location} {field} '{actual}' does not match package.json '{expected}'"
                            ),
                            Some("regenerate the lockfile after changing Recipe identity"),
                        );
                    }
                }
            }
        }
    }
}

/// Corepack requires a complete `name@semver` descriptor: it refuses a bare
/// name ("No version specified") and a partial version ("expected a semver
/// version"), so validating the name alone still lets the install abort.
fn is_pnpm_package_manager(declared: &str) -> bool {
    let Some(version) = declared.strip_prefix("pnpm@") else {
        return false;
    };
    // Corepack accepts an optional `+<hash>` integrity suffix after the version.
    let version = version.split_once('+').map_or(version, |(head, _)| head);
    let (core, _) = version.split_once('-').unwrap_or((version, ""));
    let mut parts = core.split('.');
    let numeric = |part: Option<&str>| {
        part.is_some_and(|value| !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()))
    };
    numeric(parts.next())
        && numeric(parts.next())
        && numeric(parts.next())
        && parts.next().is_none()
}

/// The one lockfile a Recipe may carry: `install-recipe-dependencies` runs
/// `pnpm install --frozen-lockfile`, which reads no other.
const PNPM_LOCKFILE: &str = "pnpm-lock.yaml";
const FOREIGN_LOCKFILES: [&str; 3] = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock"];

const MCP_LOCAL_CONFIG: &str = ".pi/mcp.local.json";
const MCP_LOCAL_EXAMPLE: &str = ".pi/mcp.local.example.json";
const LOCAL_CONFIG_PRESENT: &str = "package.local_config_present";
const LOCAL_CONFIG_HELP: &str = "commit only evaluation bindings: every server a declared id, once, streamable_http to a loopback or single-label host such as http://localhost:<port>/mcp or a compose service's http://fakes:<port>/<id>/mcp, with no auth flow; keep any other local configuration out of the Recipe";

/// A committed `.pi/mcp.local.json` is accepted only as an evaluation binding:
/// every server is a declared id reaching a loopback address or a compose
/// service over streamable HTTP, so the file can stand a fake in for a declared
/// server and nothing else. An evaluation runs the fake beside the Recipe; a
/// real endpoint or credential stays local.
fn validate_mcp_local_config(declared: &BTreeSet<String>, ctx: &mut CheckContext) {
    if !ctx.has_file(MCP_LOCAL_CONFIG) {
        return;
    }
    let Some(content) = ctx.content(MCP_LOCAL_CONFIG).map(str::to_owned) else {
        ctx.error(
            LOCAL_CONFIG_PRESENT,
            MCP_LOCAL_CONFIG,
            "Local capability configuration must not be distributed with a Recipe: .pi/mcp.local.json content was not provided, so it cannot be accepted as an evaluation binding",
            Some(LOCAL_CONFIG_HELP),
        );
        return;
    };
    for reason in non_evaluation_binding_reasons(&content, declared) {
        ctx.error(
            LOCAL_CONFIG_PRESENT,
            MCP_LOCAL_CONFIG,
            format!(
                "Local capability configuration must not be distributed with a Recipe: {reason}"
            ),
            Some(LOCAL_CONFIG_HELP),
        );
    }
}

/// Everything in a `.pi/mcp.local.json` that makes it more than an evaluation
/// binding. Empty means every server is a declared id, named once, at a
/// loopback or single-label streamable HTTP endpoint.
fn non_evaluation_binding_reasons(content: &str, declared: &BTreeSet<String>) -> Vec<String> {
    let parsed: JsonValue = match serde_json::from_str(content) {
        Ok(value) => value,
        Err(err) => return vec![format!(".pi/mcp.local.json is not valid JSON: {err}")],
    };
    let JsonValue::Object(map) = parsed else {
        return vec![".pi/mcp.local.json must be an object".to_owned()];
    };
    let Some(servers) = map.get("servers") else {
        return Vec::new();
    };
    let JsonValue::Array(servers) = servers else {
        return vec!["servers must be an array".to_owned()];
    };
    let mut reasons = Vec::new();
    let mut seen = BTreeSet::new();
    for (index, server) in servers.iter().enumerate() {
        let JsonValue::Object(server) = server else {
            reasons.push(format!("servers[{index}] must be an object"));
            continue;
        };
        // An id the package does not declare is ignored at run time, so a
        // misspelling would silently fall through to the live endpoint.
        match string_value(server.get("id")).filter(|id| !id.trim().is_empty()) {
            None => reasons.push(format!("servers[{index}].id must be a non-empty string")),
            Some(id) => {
                let normalized = safe_mcp_server_id(&id);
                if !declared.contains(&normalized) {
                    reasons.push(format!(
                        "servers[{index}].id \"{id}\" is not declared in package.json#pi.mcp.servers"
                    ));
                }
                if !seen.insert(normalized) {
                    reasons.push(format!(
                        "servers[{index}].id \"{id}\" is bound more than once"
                    ));
                }
            }
        }
        if let Some(transport) = server.get("transport") {
            if string_value(Some(transport)).as_deref() != Some("streamable_http") {
                reasons.push(format!(
                    "servers[{index}].transport must be streamable_http"
                ));
            }
        }
        for key in ["auth", "command"] {
            if server.contains_key(key) {
                reasons.push(format!(
                    "servers[{index}].{key} binds more than a loopback endpoint"
                ));
            }
        }
        match string_value(server.get("url")) {
            Some(url) if is_evaluation_http_url(&url) => {}
            _ => reasons.push(format!(
                "servers[{index}].url must be an absolute HTTP(S) URL to a loopback host (localhost, 127.0.0.0/8 or ::1) or a single-label compose service name; an environment reference is not expanded in a committed binding"
            )),
        }
        match server.get("headers") {
            None => {}
            Some(JsonValue::Object(headers)) => {
                for (key, value) in headers {
                    if !matches!(value, JsonValue::String(_)) {
                        reasons.push(format!("servers[{index}].headers.{key} must be a string"));
                    }
                }
            }
            Some(_) => reasons.push(format!("servers[{index}].headers must be an object")),
        }
    }
    reasons
}

/// A loopback address, or a single DNS label such as a compose service name: a
/// name without a dot is never a public domain, and resolves only on the
/// evaluation's own network.
fn is_evaluation_http_url(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    match url.host() {
        Some(url::Host::Domain(domain)) => is_dns_label(domain),
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

fn is_dns_label(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 63
        && !name.starts_with('-')
        && !name.ends_with('-')
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn validate_mcp_local_example(ctx: &mut CheckContext) {
    if !ctx.has_file(MCP_LOCAL_EXAMPLE) {
        return;
    }
    let Some(content) = ctx.content(MCP_LOCAL_EXAMPLE).map(str::to_owned) else {
        ctx.error(
            "mcp.local_example_unreadable",
            MCP_LOCAL_EXAMPLE,
            "MCP local example content was not provided",
            Some("supply .pi/mcp.local.example.json content to the validator"),
        );
        return;
    };
    let parsed: JsonValue = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(err) => {
            ctx.error_at(
                "mcp.local_example_malformed",
                MCP_LOCAL_EXAMPLE,
                Some(Span {
                    line: err.line(),
                    column: err.column(),
                }),
                format!(".pi/mcp.local.example.json is not valid JSON: {err}"),
                Some("fix the local MCP config template JSON"),
            );
            return;
        }
    };
    let JsonValue::Object(map) = parsed else {
        ctx.error(
            "mcp.local_example_invalid",
            MCP_LOCAL_EXAMPLE,
            ".pi/mcp.local.example.json must be an object",
            Some("fix the file structure or remove the optional example"),
        );
        return;
    };
    let Some(servers) = map.get("servers") else {
        return;
    };
    let JsonValue::Array(servers) = servers else {
        ctx.error(
            "mcp.local_example_invalid",
            MCP_LOCAL_EXAMPLE,
            ".pi/mcp.local.example.json servers must be an array",
            Some("fix the server list or remove the optional example"),
        );
        return;
    };
    for (index, server) in servers.iter().enumerate() {
        let JsonValue::Object(server) = server else {
            ctx.error(
                "mcp.local_example_invalid",
                MCP_LOCAL_EXAMPLE,
                format!("servers[{index}] must be an object"),
                Some("fix the server entry or remove it"),
            );
            continue;
        };
        for key in ["id", "name", "transport", "url"] {
            if let Some(value) = server.get(key) {
                if string_value(Some(value)).is_none() {
                    ctx.error(
                        "mcp.local_example_invalid",
                        MCP_LOCAL_EXAMPLE,
                        format!("servers[{index}].{key} must be a non-empty string"),
                        Some("remove the field or provide a non-empty value"),
                    );
                }
            }
        }
        if let Some(headers) = server.get("headers") {
            let JsonValue::Object(headers) = headers else {
                ctx.error(
                    "mcp.local_example_invalid",
                    MCP_LOCAL_EXAMPLE,
                    format!("servers[{index}].headers must be an object"),
                    Some("remove headers or make it a string-valued mapping"),
                );
                continue;
            };
            for (key, value) in headers {
                if !matches!(value, JsonValue::String(_)) {
                    ctx.error(
                        "mcp.local_example_invalid",
                        MCP_LOCAL_EXAMPLE,
                        format!("servers[{index}].headers.{key} must be a string"),
                        Some("remove the header or provide a string value"),
                    );
                }
            }
        }
    }
}

fn validate_pi_config(
    package: &Package,
    ctx: &mut CheckContext,
) -> HashMap<&'static str, Vec<String>> {
    let mut resolved = HashMap::new();
    let Some(JsonValue::Object(pi)) = package.pi.as_ref() else {
        return resolved;
    };
    let known: HashSet<&str> = [
        "agents",
        "extensions",
        "skills",
        "prompts",
        "channels",
        "documents",
        "productivity",
        "search",
        "issues",
        "mcp",
        "runtime",
        "evals",
    ]
    .into_iter()
    .collect();
    for key in pi.keys() {
        if !known.contains(key.as_str()) {
            ctx.error(
                "pi.unknown_key",
                PACKAGE_JSON,
                format!("package.json#pi contains unknown key '{key}'"),
                Some(
                    "remove unknown pi keys or update introspection-recipe-check if this is a new recipe field",
                ),
            );
        }
    }

    let agents = resource_patterns("agents", pi.get("agents"), true, ctx);
    let extensions = resource_patterns("extensions", pi.get("extensions"), false, ctx);
    let skills = resource_patterns("skills", pi.get("skills"), false, ctx);
    let prompts = resource_patterns("prompts", pi.get("prompts"), false, ctx);

    for (key, patterns, required) in [
        ("agents", agents, true),
        ("extensions", extensions, false),
        ("skills", skills, false),
        ("prompts", prompts, false),
    ] {
        let paths = resolve_resource_patterns(key, &patterns, required, ctx);
        if required && paths.is_empty() {
            ctx.error(
                "package.agents_missing",
                PACKAGE_JSON,
                "Recipe declares no loadable agents",
                Some("add agents/*.yaml or configure package.json#pi.agents"),
            );
        }
        resolved.insert(key, paths);
    }

    if let Some(channels) = pi.get("channels") {
        validate_channel_config(channels, package, ctx);
    }
    if let Some(documents) = pi.get("documents") {
        validate_documents_config(documents, package, ctx);
    }
    if let Some(productivity) = pi.get("productivity") {
        validate_productivity_config(productivity, package, ctx);
    }
    if let Some(search) = pi.get("search") {
        validate_provider_family(&SEARCH_FAMILY, search, package, ctx);
    }
    if let Some(issues) = pi.get("issues") {
        validate_provider_family(&ISSUES_FAMILY, issues, package, ctx);
    }
    validate_mcp_config(pi.get("mcp"), ctx);
    validate_runtime_config(pi.get("runtime"), ctx);
    validate_evals_config(pi.get("evals"), ctx);

    resolved
}

/// The companion packages: the first-party channel, document format,
/// productivity provider and search provider packages Recipes installs alongside itself, so a Recipe may omit them. They are the
/// keys of `optionalDependencies` in the `@introspection-ai/recipes`
/// package.json; a test keeps the two in step.
const COMPANION_PACKAGES: [&str; 7] = [
    "@introspection-ai/recipe-channel-slack",
    "@introspection-ai/recipe-documents-docx",
    "@introspection-ai/recipe-documents-pdf",
    "@introspection-ai/recipe-productivity-google",
    "@introspection-ai/recipe-productivity-microsoft",
    "@introspection-ai/recipe-issues",
    "@introspection-ai/recipe-search",
];

fn versioned_keys(value: Option<&JsonValue>) -> BTreeSet<String> {
    value
        .and_then(JsonValue::as_object)
        .map(|object| {
            object
                .iter()
                .filter(|(_, version)| string_value(Some(version)).is_some())
                .map(|(name, _)| name.to_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn object_keys(value: Option<&JsonValue>) -> BTreeSet<String> {
    value
        .and_then(JsonValue::as_object)
        .map(|object| object.keys().cloned().collect())
        .unwrap_or_default()
}

/// The packages the host imports itself and so always provides: Recipes and
/// Recipes' own `peerDependencies`. A test keeps the two in step.
const HOST_PEER_PACKAGES: [&str; 6] = [
    "@introspection-ai/recipes",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
];

/// Why a channel or document declaration's package is declared wrongly. In
/// `dependencies` with a version, the Recipe brings and pins it; in
/// `peerDependencies`, the platform provides it (see `validate_peers`).
/// Omitted entirely, only a companion package is supplied; every other package
/// must be declared.
fn declaration_package_problem(
    declaration: &str,
    package_name: &str,
    package: &Package,
) -> Option<String> {
    let required = format!("{declaration} requires dependency '{package_name}'");
    if package.dependency_keys.contains(package_name) {
        return (!package.dependencies.contains(package_name)).then_some(required);
    }
    if package.peer_dependency_keys.contains(package_name) {
        return None;
    }
    (!COMPANION_PACKAGES.contains(&package_name)).then_some(required)
}

/// A peer means the platform running the Recipe provides it: the managed
/// install never installs peers. Each needs a version range; one that is
/// neither a host import nor a companion package is a warning, since a standard
/// platform does not provide it.
fn validate_peers(package: &Package, ctx: &mut CheckContext) {
    for name in &package.peer_dependency_keys {
        if !package.peer_dependencies.contains(name) {
            ctx.error(
                "package.peer_version_missing",
                PACKAGE_JSON,
                format!("package.json#peerDependencies '{name}' needs a version range"),
                Some("give the peer a range, such as >=1.0.0"),
            );
        } else if !HOST_PEER_PACKAGES.contains(&name.as_str())
            && !COMPANION_PACKAGES.contains(&name.as_str())
        {
            ctx.warning(
                "package.peer_not_provided_by_default",
                PACKAGE_JSON,
                format!("package.json#peerDependencies '{name}' is not provided by a standard platform: the platform running the Recipe must provide it, or the runtime image build fails"),
                Some("add it to dependencies to bring it with the Recipe"),
            );
        }
    }
}

fn validate_channel_config(value: &JsonValue, package: &Package, ctx: &mut CheckContext) {
    let JsonValue::Array(connectors) = value else {
        ctx.error(
            "pi.channels_invalid",
            PACKAGE_JSON,
            "package.json#pi.channels must be an array",
            Some("use a list of channel declarations"),
        );
        return;
    };

    let mut providers = BTreeSet::new();
    for (index, connector) in connectors.iter().enumerate() {
        let JsonValue::Object(connector) = connector else {
            ctx.error(
                "pi.channels_invalid",
                PACKAGE_JSON,
                format!("package.json#pi.channels[{index}] must be an object"),
                Some("remove the entry or make it a channel declaration"),
            );
            continue;
        };
        for key in connector
            .keys()
            .filter(|key| !matches!(key.as_str(), "provider" | "commands" | "requireReply"))
        {
            ctx.error(
                "pi.channels_invalid",
                PACKAGE_JSON,
                format!("package.json#pi.channels[{index}] contains unknown field '{key}'"),
                Some("use provider, optional commands, and optional requireReply"),
            );
        }

        if connector
            .get("requireReply")
            .is_some_and(|value| !value.is_boolean())
        {
            ctx.error(
                "pi.channels_invalid",
                PACKAGE_JSON,
                format!("package.json#pi.channels[{index}].requireReply must be a boolean"),
                Some("use true or false"),
            );
        }
        if let Some(commands) = connector.get("commands") {
            if unique_names(commands).is_none() {
                ctx.error("pi.channels_invalid", PACKAGE_JSON,
                    format!("package.json#pi.channels[{index}].commands must be an array of unique non-empty strings"), Some("use a list of unique command names"));
            }
        }

        let provider = string_value(connector.get("provider"));
        match provider.as_deref() {
            Some(provider) if !providers.insert(provider.to_owned()) => ctx.error(
                "pi.channels_invalid",
                PACKAGE_JSON,
                format!("package.json#pi.channels contains duplicate provider '{provider}'"),
                Some("declare each channel provider once"),
            ),
            Some(_) => {}
            None => ctx.error(
                "pi.channels_invalid",
                PACKAGE_JSON,
                format!("package.json#pi.channels[{index}].provider must be non-empty"),
                Some("name the channel provider"),
            ),
        }

        if let Some(provider) = provider.as_deref() {
            if let Some(problem) = declaration_package_problem(
                &format!("package.json#pi.channels provider '{provider}'"),
                &format!("@introspection-ai/recipe-channel-{provider}"),
                package,
            ) {
                ctx.error(
                    "pi.channels_invalid",
                    PACKAGE_JSON,
                    problem,
                    Some("add the channel package to package.json#dependencies and commit the lockfile"),
                );
            }
        }
    }
}

const DOCUMENT_COMMANDS: [&str; 7] = [
    "read",
    "revise",
    "propose_edits",
    "comment",
    "respond",
    "remove_section",
    "render",
];

/// Why a profile value is invalid. A profile is the name of one the format package
/// ships (checked when the Recipe loads), or a relative path to a profile folder in
/// the Recipe: a skill folder whose SKILL.md the TypeScript check and the runtime read.
fn document_profile_problem(profile: &JsonValue) -> Option<String> {
    const USAGE: &str = "must be the name of a profile the format ships, such as legal-redlining-en-US, or a relative path to a profile folder in the Recipe";
    let Some(profile) = profile.as_str().filter(|value| !value.trim().is_empty()) else {
        return Some(USAGE.to_owned());
    };
    let is_path = profile.contains('/') || profile.contains('\\') || profile.starts_with('.');
    if !is_path {
        let valid = profile
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_alphanumeric())
            && profile
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-');
        return (!valid).then(|| USAGE.to_owned());
    }
    let absolute =
        profile.starts_with('/') || profile.starts_with('\\') || profile.get(1..2) == Some(":");
    (absolute || profile.split(['/', '\\']).any(|part| part == ".."))
        .then(|| format!("'{profile}' must be a relative path inside the Recipe"))
}

/// `pi.documents` mirrors `pi.channels`: one declaration per format, each
/// naming the `@introspection-ai/recipe-documents-<format>` package that must
/// be declared unless Recipes installs it alongside itself (see
/// `COMPANION_PACKAGES`), with an optional `commands` allowlist from the neutral
/// vocabulary. Whether a format supports a command is checked when the
/// runtime loads the package's capability descriptor.
fn validate_documents_config(value: &JsonValue, package: &Package, ctx: &mut CheckContext) {
    const CODE: &str = "pi.documents_invalid";
    let JsonValue::Array(declarations) = value else {
        ctx.error(
            CODE,
            PACKAGE_JSON,
            "package.json#pi.documents must be an array",
            Some("use a list of document format declarations, like [{ \"format\": \"word\" }]"),
        );
        return;
    };
    let mut formats = BTreeSet::new();
    for (index, declaration) in declarations.iter().enumerate() {
        let JsonValue::Object(declaration) = declaration else {
            ctx.error(
                CODE,
                PACKAGE_JSON,
                format!("package.json#pi.documents[{index}] must be an object"),
                Some("remove the entry or make it a document format declaration"),
            );
            continue;
        };
        for key in declaration
            .keys()
            .filter(|key| !matches!(key.as_str(), "format" | "commands" | "profile"))
        {
            ctx.error(
                CODE,
                PACKAGE_JSON,
                format!("package.json#pi.documents[{index}] contains unknown field '{key}'"),
                Some("use format, and optional commands and profile"),
            );
        }
        if let Some(commands) = declaration.get("commands") {
            let names = unique_names(commands);
            if names.is_none() {
                ctx.error(
                    CODE,
                    PACKAGE_JSON,
                    format!("package.json#pi.documents[{index}].commands must be an array of unique non-empty strings"),
                    Some("use a list of unique command names"),
                );
            } else if let Some(unknown) = names
                .iter()
                .flatten()
                .find(|command| !DOCUMENT_COMMANDS.contains(command))
            {
                ctx.error(
                    CODE,
                    PACKAGE_JSON,
                    format!("package.json#pi.documents[{index}].commands contains unknown command '{unknown}'"),
                    Some("use read, revise, propose_edits, comment, respond, remove_section or render"),
                );
            }
        }
        if let Some(problem) = declaration
            .get("profile")
            .and_then(document_profile_problem)
        {
            ctx.error(
                CODE,
                PACKAGE_JSON,
                format!("package.json#pi.documents[{index}].profile {problem}"),
                Some("name a profile the format ships, such as legal-redlining-en-US, or a profile folder such as ./profiles/house-style-en-gb"),
            );
        }
        let format = string_value(declaration.get("format"));
        match format.as_deref() {
            Some(format) if !formats.insert(format.to_owned()) => ctx.error(
                CODE,
                PACKAGE_JSON,
                format!("package.json#pi.documents contains duplicate format '{format}'"),
                Some("declare each document format once"),
            ),
            Some(format) => {
                if let Some(problem) = declaration_package_problem(
                    &format!("package.json#pi.documents format '{format}'"),
                    &format!("@introspection-ai/recipe-documents-{format}"),
                    package,
                ) {
                    ctx.error(
                        CODE,
                        PACKAGE_JSON,
                        problem,
                        Some("add the document format package to package.json#dependencies and commit the lockfile"),
                    );
                }
            }
            None => ctx.error(
                CODE,
                PACKAGE_JSON,
                format!("package.json#pi.documents[{index}].format must be non-empty"),
                Some("name the document format, such as docx or pdf"),
            ),
        }
    }
}

/// The productivity tools and their commands, as the host names them.
const PRODUCTIVITY_COMMANDS: [(&str, &[&str]); 3] = [
    (
        "mail",
        &[
            "search",
            "read",
            "fetch_attachment",
            "draft",
            "update_draft",
            "send",
            "move",
            "label",
        ],
    ),
    (
        "calendar",
        &[
            "list",
            "read",
            "free_busy",
            "create",
            "update",
            "respond",
            "cancel",
        ],
    ),
    ("drive", &["search", "read", "download", "upload"]),
];

/// `pi.productivity` holds one provider, served by
/// `@introspection-ai/recipe-productivity-<provider>`, with an optional
/// allowlist of commands per tool. Whether the provider supports each command
/// is checked when the runtime loads the provider's capability descriptor.
fn validate_productivity_config(value: &JsonValue, package: &Package, ctx: &mut CheckContext) {
    const CODE: &str = "pi.productivity_invalid";
    let JsonValue::Array(declarations) = value else {
        ctx.error(
            CODE,
            PACKAGE_JSON,
            "package.json#pi.productivity must be an array",
            Some(
                "use a list with one provider declaration, like [{ \"provider\": \"microsoft\" }]",
            ),
        );
        return;
    };
    if declarations.len() > 1 {
        ctx.error(
            CODE,
            PACKAGE_JSON,
            "package.json#pi.productivity declares more than one provider; a Recipe uses one productivity provider",
            Some("keep one provider declaration"),
        );
    }
    for (index, declaration) in declarations.iter().enumerate() {
        let JsonValue::Object(declaration) = declaration else {
            ctx.error(
                CODE,
                PACKAGE_JSON,
                format!("package.json#pi.productivity[{index}] must be an object"),
                Some("make it a provider declaration"),
            );
            continue;
        };
        for key in declaration
            .keys()
            .filter(|key| !matches!(key.as_str(), "provider" | "tools" | "package"))
        {
            ctx.error(
                CODE,
                PACKAGE_JSON,
                format!("package.json#pi.productivity[{index}] contains unknown field '{key}'"),
                Some("use provider, optional tools, and an optional package"),
            );
        }
        let sourced = validate_provider_source("productivity", index, declaration, package, ctx);
        if let Some(tools) = declaration.get("tools") {
            let Some(tools) = tools.as_object() else {
                ctx.error(
                    CODE,
                    PACKAGE_JSON,
                    format!("package.json#pi.productivity[{index}].tools must be an object"),
                    Some("map mail, calendar or drive to a list of commands"),
                );
                continue;
            };
            for (tool, commands) in tools {
                let Some((_, known)) = PRODUCTIVITY_COMMANDS
                    .iter()
                    .find(|(name, _)| *name == tool.as_str())
                else {
                    ctx.error(
                        CODE,
                        PACKAGE_JSON,
                        format!("package.json#pi.productivity[{index}].tools contains unknown tool '{tool}'"),
                        Some("use mail, calendar or drive"),
                    );
                    continue;
                };
                let names = unique_names(commands);
                if names.is_none() {
                    ctx.error(
                        CODE,
                        PACKAGE_JSON,
                        format!("package.json#pi.productivity[{index}].tools.{tool} must be an array of unique non-empty strings"),
                        Some("use a list of unique command names"),
                    );
                } else if let Some(unknown) = names
                    .iter()
                    .flatten()
                    .find(|command| !known.contains(command))
                {
                    ctx.error(
                        CODE,
                        PACKAGE_JSON,
                        format!("package.json#pi.productivity[{index}].tools.{tool} contains unknown command '{unknown}'"),
                        Some(format!("use {}", known.join(", "))),
                    );
                }
            }
        }
        match string_value(declaration.get("provider")).as_deref() {
            Some(_) if sourced => {}
            Some(provider) => {
                if let Some(problem) = declaration_package_problem(
                    &format!("package.json#pi.productivity provider '{provider}'"),
                    &format!("@introspection-ai/recipe-productivity-{provider}"),
                    package,
                ) {
                    ctx.error(
                        CODE,
                        PACKAGE_JSON,
                        problem,
                        Some("add the productivity provider package to package.json#dependencies and commit the lockfile"),
                    );
                }
            }
            None => ctx.error(
                CODE,
                PACKAGE_JSON,
                format!("package.json#pi.productivity[{index}].provider must be non-empty"),
                Some("name the provider, such as microsoft or google"),
            ),
        }
    }
}

/// The first-party search providers `@introspection-ai/recipe-search` serves; a
/// Recipe's own provider names a `package` instead.
const FIRST_PARTY_SEARCH_PROVIDERS: [&str; 6] = [
    "tavily",
    "parallel",
    "exa",
    "keenable",
    "perplexity",
    "brave",
];

/// Checks a provider declaration's own `package`, and returns whether it has
/// one, so the caller skips the first-party package.
fn validate_provider_source(
    family: &str,
    index: usize,
    declaration: &JsonMap,
    package: &Package,
    ctx: &mut CheckContext,
) -> bool {
    let code = format!("pi.{family}_invalid");
    let package_name = declaration.get("package");
    if let Some(value) = package_name {
        match value.as_str().map(str::trim).filter(|name| !name.is_empty()) {
            // A Recipe's own provider is a third-party package: an ordinary,
            // versioned dependency, never a peer or an omitted companion,
            // since a managed install installs neither.
            Some(name) if !package.dependencies.contains(name) => ctx.error(
                &code,
                PACKAGE_JSON,
                format!(
                    "package.json#pi.{family}[{index}].package requires '{name}' in package.json#dependencies with a version"
                ),
                Some("add the provider package to package.json#dependencies with a version and commit the lockfile"),
            ),
            Some(_) => {}
            None => ctx.error(
                &code,
                PACKAGE_JSON,
                format!("package.json#pi.{family}[{index}].package must be a non-empty package name"),
                Some("name the npm package that serves the provider"),
            ),
        }
        return true;
    }
    false
}

/// The type of one value in a declaration's `options`.
#[derive(Clone, Copy, PartialEq)]
enum OptionType {
    String,
    Boolean,
}

/// The options a provider takes, by name and type.
type OptionsSchema = &'static [(&'static str, OptionType)];

/// A provider family's declarations: its first-party ids, the package that
/// serves them, and, for a family whose providers take `options`, the options
/// each first-party provider takes. The top level takes nothing else beside
/// the fallback's `enabled`.
struct ProviderFamily {
    name: &'static str,
    first_party: &'static [&'static str],
    bundle: &'static str,
    example: &'static str,
    /// The options schema of a first-party id; `None` when the family takes
    /// no `options`.
    options: Option<fn(&str) -> OptionsSchema>,
    /// The one provider that takes `enabled`, if the family has a fallback.
    fallback: Option<&'static str>,
}

const SEARCH_FAMILY: ProviderFamily = ProviderFamily {
    name: "search",
    first_party: &FIRST_PARTY_SEARCH_PROVIDERS,
    bundle: "@introspection-ai/recipe-search",
    example: "brave",
    options: None,
    fallback: None,
};

const ISSUES_FAMILY: ProviderFamily = ProviderFamily {
    name: "issues",
    first_party: &["linear", "jira", "introspection"],
    bundle: "@introspection-ai/recipe-issues",
    example: "linear",
    options: Some(|provider| match provider {
        "linear" => &[("team", OptionType::String), ("server", OptionType::String)],
        "jira" => &[
            ("project", OptionType::String),
            ("issueType", OptionType::String),
            ("server", OptionType::String),
        ],
        _ => &[],
    }),
    fallback: Some("introspection"),
};

/// `pi.search` and `pi.issues`: first-party providers by id, with their
/// options, and a Recipe's own by `package`, whose options it checks itself
/// when it loads.
fn validate_provider_family(
    family: &ProviderFamily,
    value: &JsonValue,
    package: &Package,
    ctx: &mut CheckContext,
) {
    let name = family.name;
    let code = format!("pi.{name}_invalid");
    let JsonValue::Array(declarations) = value else {
        ctx.error(
            &code,
            PACKAGE_JSON,
            format!("package.json#pi.{name} must be an array"),
            Some(format!(
                "use a list of provider declarations, like [{{ \"provider\": \"{}\" }}]",
                family.example
            )),
        );
        return;
    };
    let mut allowed = vec!["provider", "package"];
    if family.options.is_some() {
        allowed.push("options");
    }
    if family.fallback.is_some() {
        allowed.push("enabled");
    }
    let mut seen = HashSet::new();
    for (index, declaration) in declarations.iter().enumerate() {
        let JsonValue::Object(declaration) = declaration else {
            ctx.error(
                &code,
                PACKAGE_JSON,
                format!("package.json#pi.{name}[{index}] must be an object"),
                Some("make it a provider declaration"),
            );
            continue;
        };
        let Some(provider) = string_value(declaration.get("provider")) else {
            ctx.error(
                &code,
                PACKAGE_JSON,
                format!("package.json#pi.{name}[{index}].provider must be non-empty"),
                Some(format!("name the provider, such as {}", family.example)),
            );
            continue;
        };
        for key in declaration
            .keys()
            .filter(|key| !allowed.contains(&key.as_str()))
        {
            ctx.error(
                &code,
                PACKAGE_JSON,
                format!("package.json#pi.{name}[{index}] contains unknown field '{key}'"),
                Some(format!(
                    "use {}; put the provider's own settings in options",
                    allowed.join(", ")
                )),
            );
        }
        if let Some(enabled) = declaration.get("enabled") {
            if Some(provider.as_str()) != family.fallback {
                ctx.error(
                    &code,
                    PACKAGE_JSON,
                    format!("package.json#pi.{name}[{index}].enabled applies only to the fallback provider"),
                    Some(format!("remove the declaration to leave '{provider}' out")),
                );
            } else if !enabled.is_boolean() {
                ctx.error(
                    &code,
                    PACKAGE_JSON,
                    format!("package.json#pi.{name}[{index}].enabled must be a boolean"),
                    Some("use true or false"),
                );
            }
        }
        if let (Some(schema_of), Some(options)) = (family.options, declaration.get("options")) {
            validate_provider_options(
                &code,
                &format!("package.json#pi.{name}[{index}].options"),
                &provider,
                options,
                (!declaration.contains_key("package")).then(|| schema_of(&provider)),
                ctx,
            );
        }
        if !seen.insert(provider.clone()) {
            ctx.error(
                &code,
                PACKAGE_JSON,
                format!("package.json#pi.{name} declares provider '{provider}' more than once"),
                Some("declare each provider once"),
            );
        }
        if validate_provider_source(name, index, declaration, package, ctx) {
            continue;
        }
        if !family.first_party.contains(&provider.as_str()) {
            ctx.error(
                &code,
                PACKAGE_JSON,
                format!(
                    "package.json#pi.{name} provider '{provider}' is not first-party and names no package"
                ),
                Some(format!(
                    "use one of {}, or give it a package",
                    family.first_party.join(", ")
                )),
            );
        } else if let Some(problem) = declaration_package_problem(
            &format!("package.json#pi.{name} provider '{provider}'"),
            family.bundle,
            package,
        ) {
            ctx.error(
                &code,
                PACKAGE_JSON,
                problem,
                Some(format!(
                    "add {} to package.json#dependencies and commit the lockfile",
                    family.bundle
                )),
            );
        }
    }
}

/// A declaration's `options`: an object, checked against `schema` for a
/// first-party provider, and only for its value types for a Recipe's own,
/// which checks its options against its own schema when it loads.
fn validate_provider_options(
    code: &str,
    at: &str,
    provider: &str,
    options: &JsonValue,
    schema: Option<OptionsSchema>,
    ctx: &mut CheckContext,
) {
    let Some(options) = options.as_object() else {
        ctx.error(
            code,
            PACKAGE_JSON,
            format!("{at} must be an object"),
            Some("map each option name to its value"),
        );
        return;
    };
    for (key, value) in options {
        let expected = match schema {
            Some(schema) => {
                let Some((_, kind)) = schema.iter().find(|(name, _)| name == key) else {
                    let takes: Vec<&str> = schema.iter().map(|(name, _)| *name).collect();
                    ctx.error(
                        code,
                        PACKAGE_JSON,
                        format!("{at}: provider '{provider}' takes no option '{key}'"),
                        Some(if takes.is_empty() {
                            "remove options".to_string()
                        } else {
                            format!("use {}", takes.join(", "))
                        }),
                    );
                    continue;
                };
                *kind
            }
            None if value.is_boolean() => OptionType::Boolean,
            None => OptionType::String,
        };
        let valid = match expected {
            OptionType::Boolean => value.is_boolean(),
            OptionType::String => value.as_str().is_some_and(|text| !text.trim().is_empty()),
        };
        if !valid {
            ctx.error(
                code,
                PACKAGE_JSON,
                match expected {
                    OptionType::Boolean => format!("{at}.{key} must be a boolean"),
                    OptionType::String => format!("{at}.{key} must be a non-empty string"),
                },
                None::<String>,
            );
        }
    }
}

fn validate_runtime_config(value: Option<&JsonValue>, ctx: &mut CheckContext) {
    let Some(value) = value else { return };
    let Some(runtime) = value.as_object() else {
        ctx.error(
            "pi.runtime_invalid",
            PACKAGE_JSON,
            "package.json#pi.runtime must be an object",
            None::<String>,
        );
        return;
    };
    for key in runtime.keys() {
        if key != "python" {
            ctx.error(
                "pi.runtime_invalid",
                PACKAGE_JSON,
                format!("package.json#pi.runtime contains unknown field '{key}'"),
                None::<String>,
            );
        }
    }
    if let Some(python_value) = runtime.get("python") {
        let Some(python) = python_value.as_object() else {
            ctx.error(
                "pi.runtime_invalid",
                PACKAGE_JSON,
                "package.json#pi.runtime.python must be an object",
                None::<String>,
            );
            return;
        };
        for key in python.keys() {
            if !matches!(key.as_str(), "project" | "lockfile" | "version" | "imports") {
                ctx.error(
                    "pi.runtime_invalid",
                    PACKAGE_JSON,
                    format!("package.json#pi.runtime.python contains unknown field '{key}'"),
                    None::<String>,
                );
            }
        }
        for key in ["project", "lockfile"] {
            let Some(path) = string_value(python.get(key)) else {
                ctx.error(
                    "pi.runtime_invalid",
                    PACKAGE_JSON,
                    format!(
                        "package.json#pi.runtime.python.{key} must be a non-empty relative path"
                    ),
                    None::<String>,
                );
                continue;
            };
            let normalized = normalize_relative(&path);
            if normalized.is_empty()
                || normalized != path
                || (!ctx.has_file(&normalized) && key == "lockfile")
                || (!ctx.has_dir(&normalized) && key == "project")
            {
                ctx.error("pi.runtime_path_invalid", PACKAGE_JSON, format!("package.json#pi.runtime.python.{key} must resolve inside the recipe: {path}"), None::<String>);
            }
        }
        if let Some(imports) = python.get("imports") {
            let valid = imports
                .as_array()
                .is_some_and(|items| items.iter().all(|item| string_value(Some(item)).is_some()));
            if !valid {
                ctx.error("pi.runtime_invalid", PACKAGE_JSON, "package.json#pi.runtime.python.imports must be an array of non-empty module names", None::<String>);
            } else {
                for item in imports.as_array().into_iter().flatten() {
                    let Some(name) = string_value(Some(item)) else {
                        continue;
                    };
                    if !is_python_module_name(name.trim()) {
                        ctx.error(
                            "pi.runtime_invalid",
                            PACKAGE_JSON,
                            format!("package.json#pi.runtime.python.imports entry '{name}' must be a dotted Python module name"),
                            Some("name an importable module, such as docx or paper_docx.api"),
                        );
                    }
                }
            }
        }
    }
}

/// A dotted Python module name: identifiers of ASCII letters, digits and `_`,
/// none starting with a digit, joined by `.`.
fn is_python_module_name(value: &str) -> bool {
    !value.is_empty()
        && value.split('.').all(|part| {
            let mut chars = part.chars();
            chars
                .next()
                .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
}

const RECIPE_IGNORE: &str = ".recipeignore";
const EVALS_INVALID: &str = "pi.evals_invalid";
const EVALS_PATH_INVALID: &str = "pi.evals_path_invalid";
const EVALS_SUITE_MISSING: &str = "pi.evals_suite_missing";
const EVALS_TASK_MISSING: &str = "pi.evals_task_missing";
const EVALS_NOT_IGNORED: &str = "pi.evals_not_ignored";
const EVALS_IGNORE_UNREADABLE: &str = "pi.evals_recipeignore_unreadable";
const EVALS_STRAY_CONTENT: &str = "pi.evals_stray_content";
const EVALS_CASE_UNKNOWN: &str = "pi.evals_case_unknown";
const EVALS_CASE_DUPLICATE: &str = "pi.evals_case_duplicate";
const EVALS_CASE_UNAPPROVED: &str = "pi.evals_case_unapproved";
const EVALS_CASE_ROW_MISSING_ID: &str = "pi.evals_case_row_missing_id";
const EVALS_CASE_INVALID: &str = "pi.evals_case_invalid";
const EVALS_JUDGE_UNKNOWN: &str = "pi.evals_judge_unknown";
const EVALS_SHAPE_HELP: &str = "use { suites: [{ type: harbor | vitest, path }], lib, sources, fakes, cases } with package-relative paths";
const EVALS_PATH_HELP: &str =
    "use a package-relative path with / separators, no '..', and no glob characters";
const EVALS_IGNORE_HELP: &str =
    "add a single 'evals/' line to .recipeignore so eval-only files never reach a deployed runtime";
const DEFAULT_EVAL_SUITES: [(EvalSuiteKind, &str); 2] = [
    (EvalSuiteKind::Vitest, "evals/vitest"),
    (EvalSuiteKind::Harbor, "evals/harbor"),
];
/// Support paths and their defaults. `fakes` sits at the Recipe root because
/// local testing uses the same fakes as evals.
const EVAL_SUPPORT_KEYS: [(&str, &str); 4] = [
    ("lib", "evals/lib"),
    ("sources", "evals/sources"),
    ("fakes", "fakes"),
    ("cases", "evals/cases"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EvalSuiteKind {
    Harbor,
    Vitest,
}

#[derive(Debug, Clone)]
struct EvalSuite {
    kind: EvalSuiteKind,
    path: String,
    /// Authored in `pi.evals.suites`, as opposed to discovered by convention.
    configured: bool,
}

/// Resolved eval layout: explicit `pi.evals` entries, with defaults for
/// every key the block omits.
#[derive(Debug, Clone, Default)]
struct EvalLayout {
    suites: Vec<EvalSuite>,
    /// `(key, path)` for `lib`, `sources`, `fakes` and `cases`.
    support: Vec<(&'static str, String)>,
}

impl EvalLayout {
    fn support_path(&self, key: &str) -> Option<&str> {
        self.support
            .iter()
            .find(|(existing, _)| *existing == key)
            .map(|(_, path)| path.as_str())
    }

    /// Every eval path, suites first, deduplicated.
    fn paths(&self) -> Vec<&str> {
        let mut seen = BTreeSet::new();
        self.suites
            .iter()
            .map(|suite| suite.path.as_str())
            .chain(self.support.iter().map(|(_, path)| path.as_str()))
            .filter(|path| seen.insert(*path))
            .collect()
    }

    fn contains(&self, path: &str) -> bool {
        self.paths()
            .iter()
            .any(|root| path == *root || path.starts_with(&format!("{root}/")))
    }
}

/// Validate `package.json#pi.evals` and the eval layout it (or the default
/// layout) describes. Shape errors are fatal; layout findings are warnings so
/// existing Recipes keep passing while the contract tightens.
fn validate_evals_config(value: Option<&JsonValue>, ctx: &mut CheckContext) {
    // Layout findings against a half-understood block are noise: report the
    // shape errors alone and let the author fix those first.
    let diagnostics_before = ctx.diagnostics.len();
    let Some(layout) = eval_layout(value, ctx) else {
        return;
    };
    if ctx.diagnostics.len() > diagnostics_before {
        return;
    }
    // Eval files reaching the runtime are a leak whatever the Recipe declares.
    // The layout checks are opt-in: a Recipe takes them on by declaring
    // `pi.evals`, so an existing Recipe's eval layout is not judged by a
    // contract it never adopted.
    validate_eval_ignore(&layout, ctx);
    if value.is_none() {
        return;
    }
    validate_eval_suites(&layout, ctx);
    validate_stray_eval_content(&layout, ctx);
    validate_eval_cases(&layout, ctx);
    validate_eval_judge_references(&layout, ctx);
}

fn eval_layout(value: Option<&JsonValue>, ctx: &mut CheckContext) -> Option<EvalLayout> {
    let Some(value) = value else {
        return Some(default_eval_layout(None, ctx));
    };
    let Some(evals) = value.as_object() else {
        ctx.error(
            EVALS_INVALID,
            PACKAGE_JSON,
            "package.json#pi.evals must be an object",
            Some(EVALS_SHAPE_HELP),
        );
        return None;
    };
    for key in evals.keys() {
        if !matches!(
            key.as_str(),
            "suites" | "lib" | "sources" | "fakes" | "cases"
        ) {
            ctx.error(
                EVALS_INVALID,
                PACKAGE_JSON,
                format!("package.json#pi.evals contains unknown key '{key}'"),
                Some(EVALS_SHAPE_HELP),
            );
        }
    }

    let mut layout = default_eval_layout(Some(evals), ctx);
    if let Some(suites) = evals.get("suites") {
        layout.suites = configured_eval_suites(suites, ctx);
    }
    for (key, _) in EVAL_SUPPORT_KEYS {
        let Some(value) = evals.get(key) else {
            continue;
        };
        let label = format!("package.json#pi.evals.{key}");
        layout.support.retain(|(existing, _)| *existing != key);
        if let Some(path) = eval_path(value, &label, ctx) {
            layout.support.push((key, path));
        }
    }
    Some(layout)
}

/// The convention layout for every key `evals` does not author. Suites are
/// discovered only when their directory exists; support paths always default.
fn default_eval_layout(evals: Option<&JsonMap>, ctx: &CheckContext) -> EvalLayout {
    let authored = |key: &str| evals.is_some_and(|evals| evals.contains_key(key));
    let suites = if authored("suites") {
        Vec::new()
    } else {
        DEFAULT_EVAL_SUITES
            .iter()
            .filter(|(_, path)| ctx.has_dir(path))
            .map(|(kind, path)| EvalSuite {
                kind: *kind,
                path: (*path).to_owned(),
                configured: false,
            })
            .collect()
    };
    let support = EVAL_SUPPORT_KEYS
        .iter()
        .filter(|(key, _)| !authored(key))
        .map(|(key, path)| (*key, (*path).to_owned()))
        .collect();
    EvalLayout { suites, support }
}

fn configured_eval_suites(value: &JsonValue, ctx: &mut CheckContext) -> Vec<EvalSuite> {
    let Some(entries) = value.as_array() else {
        ctx.error(
            EVALS_INVALID,
            PACKAGE_JSON,
            "package.json#pi.evals.suites must be an array",
            Some(EVALS_SHAPE_HELP),
        );
        return Vec::new();
    };
    let mut suites: Vec<EvalSuite> = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let label = format!("package.json#pi.evals.suites[{index}]");
        let Some(entry) = entry.as_object() else {
            ctx.error(
                EVALS_INVALID,
                PACKAGE_JSON,
                format!("{label} must be an object"),
                Some("declare each suite as { type, path }"),
            );
            continue;
        };
        for key in entry
            .keys()
            .filter(|key| !matches!(key.as_str(), "type" | "path"))
        {
            ctx.error(
                EVALS_INVALID,
                PACKAGE_JSON,
                format!("{label} contains unknown field '{key}'"),
                Some("declare each suite as { type, path }"),
            );
        }
        let kind = match entry.get("type").and_then(JsonValue::as_str) {
            Some("harbor") => Some(EvalSuiteKind::Harbor),
            Some("vitest") => Some(EvalSuiteKind::Vitest),
            _ => {
                ctx.error(
                    EVALS_INVALID,
                    PACKAGE_JSON,
                    format!("{label}.type must be 'harbor' or 'vitest'"),
                    Some("set type to exactly harbor or vitest"),
                );
                None
            }
        };
        let path = match entry.get("path") {
            Some(path) => eval_path(path, &format!("{label}.path"), ctx),
            None => {
                ctx.error(
                    EVALS_INVALID,
                    PACKAGE_JSON,
                    format!("{label}.path is required"),
                    Some("name the suite directory relative to the package root"),
                );
                None
            }
        };
        let Some(path) = path else { continue };
        if suites.iter().any(|suite| suite.path == path) {
            ctx.error(
                EVALS_INVALID,
                PACKAGE_JSON,
                format!("package.json#pi.evals.suites contains duplicate path '{path}'"),
                Some("give every suite its own path"),
            );
            continue;
        }
        if let Some(kind) = kind {
            suites.push(EvalSuite {
                kind,
                path,
                configured: true,
            });
        }
    }
    suites
}

/// A normalized package-relative eval path, or `None` after reporting why the
/// authored value is not one. Containment is lexical: the snapshot carries no
/// symlink information.
fn eval_path(value: &JsonValue, label: &str, ctx: &mut CheckContext) -> Option<String> {
    let Some(raw) = value.as_str() else {
        ctx.error(
            EVALS_INVALID,
            PACKAGE_JSON,
            format!("{label} must be a string path"),
            Some(EVALS_PATH_HELP),
        );
        return None;
    };
    let reason = if raw.trim().is_empty() {
        Some("must be non-empty")
    } else if raw.contains('\\') {
        Some("must use '/' separators")
    } else if raw.starts_with('/') || Path::new(raw).is_absolute() || raw.contains(':') {
        Some("must be relative to the package root")
    } else if raw.split('/').any(|segment| segment == "..") {
        Some("must stay inside the package")
    } else if has_glob(raw) || raw.contains(['[', ']', '{', '}']) {
        Some("must be a path, not a glob pattern")
    } else {
        None
    };
    let normalized = normalize_relative(raw);
    let reason = reason.or_else(|| {
        if normalized.is_empty() || normalized == "." {
            Some("must name a directory below the package root")
        } else if normalized
            .split('/')
            .any(|segment| segment.is_empty() || segment == ".")
        {
            Some("must be a normalized path")
        } else {
            None
        }
    });
    if let Some(reason) = reason {
        ctx.error(
            EVALS_PATH_INVALID,
            PACKAGE_JSON,
            format!("{label} {reason}: '{raw}'"),
            Some(EVALS_PATH_HELP),
        );
        return None;
    }
    Some(normalized)
}

fn validate_eval_suites(layout: &EvalLayout, ctx: &mut CheckContext) {
    for suite in &layout.suites {
        if !ctx.path_exists(&suite.path) {
            if suite.configured {
                ctx.error(
                    EVALS_SUITE_MISSING,
                    PACKAGE_JSON,
                    format!(
                        "package.json#pi.evals suite path '{}' does not exist",
                        suite.path
                    ),
                    Some("create the suite directory or remove the suite from pi.evals.suites"),
                );
            }
            continue;
        }
        if suite.kind != EvalSuiteKind::Harbor {
            continue;
        }
        for task in ctx.child_dirs(&suite.path) {
            let manifest = format!("{task}/task.toml");
            if !ctx.has_file(&manifest) {
                ctx.warning(
                    EVALS_TASK_MISSING,
                    task.clone(),
                    format!("Harbor task folder '{task}' has no task.toml"),
                    Some("give every folder in a harbor suite a task.toml, or move shared code to evals/lib"),
                );
            }
        }
    }
}

fn validate_eval_ignore(layout: &EvalLayout, ctx: &mut CheckContext) {
    let existing: Vec<String> = layout
        .paths()
        .into_iter()
        .filter(|path| ctx.path_exists(path))
        .map(str::to_owned)
        .collect();
    if existing.is_empty() {
        return;
    }
    let patterns = if ctx.has_file(RECIPE_IGNORE) {
        let Some(content) = ctx.content(RECIPE_IGNORE) else {
            ctx.warning(
                EVALS_IGNORE_UNREADABLE,
                RECIPE_IGNORE,
                ".recipeignore content was not provided, so eval path exclusion was not checked",
                Some("supply .recipeignore content to the validator"),
            );
            return;
        };
        parse_recipe_ignore(content)
    } else {
        Vec::new()
    };
    for path in existing {
        if !recipe_ignore_excludes_dir(&path, &patterns) {
            let help = if path == "evals" || path.starts_with("evals/") {
                EVALS_IGNORE_HELP.to_owned()
            } else {
                format!("add a '{path}/' line to .recipeignore so eval-only files never reach a deployed runtime")
            };
            ctx.warning(
                EVALS_NOT_IGNORED,
                RECIPE_IGNORE,
                format!("eval path '{path}' is not excluded by .recipeignore"),
                Some(help),
            );
        }
    }
}

/// Warn about eval-looking files outside every eval path: a vitest-evals
/// suite (`*.eval.ts`) or a Harbor task manifest (`task.toml` with a
/// `[verifier]` table). A `task.toml` whose content was not supplied is
/// skipped; this heuristic never reports a file as unreadable.
fn validate_stray_eval_content(layout: &EvalLayout, ctx: &mut CheckContext) {
    let stray: Vec<(String, &'static str)> = ctx
        .files
        .iter()
        .filter(|(path, _)| !layout.contains(path))
        .filter_map(|(path, content)| {
            let name = path.rsplit('/').next().unwrap_or(path);
            if name.ends_with(".eval.ts") {
                Some((path.clone(), "a vitest-evals suite"))
            } else if name == "task.toml" && content.as_deref().is_some_and(toml_has_verifier_table)
            {
                Some((path.clone(), "a Harbor task"))
            } else {
                None
            }
        })
        .collect();
    for (path, what) in stray {
        ctx.warning(
            EVALS_STRAY_CONTENT,
            path.clone(),
            format!("'{path}' looks like {what} but is outside every eval path"),
            Some("move it under an eval suite (evals/vitest or evals/harbor/<task>) or declare its location in package.json#pi.evals"),
        );
    }
}

/// One runner's implementation of a case: a Vitest row or a Harbor task.
struct CaseImplementation {
    case: String,
    /// The file or folder diagnostics point at.
    path: String,
    span: Option<Span>,
    /// How messages name it, such as "row 3 of 'evals/vitest/a.eval.jsonl'".
    label: String,
}

/// Link implementations to case files: every implementation names a case
/// that exists, a case has one implementation across both runners, and an
/// implemented case is approved.
/// A broken link or case file is an error; an unapproved case only warns,
/// since a draft case is how the improve loop proposes one.
fn validate_eval_cases(layout: &EvalLayout, ctx: &mut CheckContext) {
    let cases_dir = layout.support_path("cases").unwrap_or("evals/cases");
    // Case id (the file name) -> its file and, when it parsed, front matter.
    let mut cases: BTreeMap<String, (String, Option<spec::EvalCase>)> = BTreeMap::new();
    let files: Vec<String> = ctx
        .child_files(cases_dir)
        .into_iter()
        .filter(|file| file.ends_with(".md"))
        .map(str::to_owned)
        .collect();
    for file in files {
        let name = file.rsplit('/').next().unwrap_or(&file);
        let id = name.trim_end_matches(".md").to_owned();
        let parsed = match ctx.content(&file).map(spec::parse_eval_case) {
            None => None,
            Some(Err(err)) => {
                ctx.error(
                    EVALS_CASE_INVALID,
                    file.clone(),
                    format!("case file '{file}' {err}"),
                    Some(EVALS_CASE_HELP),
                );
                None
            }
            Some(Ok(case)) => {
                validate_case_fields(&file, &id, &case, ctx);
                Some(case)
            }
        };
        cases.insert(id, (file, parsed));
    }

    let mut implementations = vitest_case_rows(layout, ctx);
    implementations.extend(harbor_case_tasks(layout, ctx));

    for implementation in &implementations {
        if cases.contains_key(&implementation.case) {
            continue;
        }
        ctx.push(
            EVALS_CASE_UNKNOWN,
            Severity::Error,
            implementation.path.clone(),
            implementation.span,
            format!(
                "{} names case '{}', which has no {cases_dir}/{}.md",
                implementation.label, implementation.case, implementation.case
            ),
            Some(format!(
                "write the case file {cases_dir}/{}.md, or name an existing case",
                implementation.case
            )),
        );
    }

    let mut first: BTreeMap<&str, &CaseImplementation> = BTreeMap::new();
    for implementation in &implementations {
        let Some(earlier) = first.get(implementation.case.as_str()) else {
            first.insert(implementation.case.as_str(), implementation);
            continue;
        };
        let message = format!(
            "case '{}' has a second implementation: {} repeats {}",
            implementation.case, implementation.label, earlier.label
        );
        ctx.push(
            EVALS_CASE_DUPLICATE,
            Severity::Error,
            implementation.path.clone(),
            implementation.span,
            message,
            Some("give a case one implementation, on one runner: keep one and delete the other, or give the second its own case"),
        );
    }

    let implemented: BTreeSet<&str> = implementations
        .iter()
        .map(|implementation| implementation.case.as_str())
        .collect();
    for (id, (file, case)) in &cases {
        let Some(case) = case else { continue };
        if !implemented.contains(id.as_str()) {
            continue;
        }
        let missing = case.missing_approval();
        if !missing.is_empty() {
            ctx.warning(
                EVALS_CASE_UNAPPROVED,
                file.clone(),
                format!(
                    "case '{id}' has an implementation but is not approved: {} empty",
                    missing.join(", ")
                ),
                Some(
                    "have the owner approve the case: fill in approved_by, approved_at and approved_in",
                ),
            );
            continue;
        }
        let body = ctx.content(file).and_then(spec::eval_case_body);
        if body.is_some_and(|body| case.approved_hash_matches(&body) == Some(false)) {
            ctx.warning(
                EVALS_CASE_UNAPPROVED,
                file.clone(),
                format!(
                    "case '{id}' has an implementation but changed since it was approved: its body no longer matches approved_hash"
                ),
                Some(format!(
                    "have the owner review the case and approve it again: introspection eval approve {id}"
                )),
            );
        }
    }
}

/// A string-literal judge reference in eval code: `recipeJudge("<name or
/// path>")` in a Vitest suite or the eval lib, `judge_reward("<name>")` in a
/// Harbor task's Python.
struct JudgeReference {
    path: String,
    span: Span,
    call: &'static str,
    reference: String,
}

/// `recipeJudge(...)` and `judge_reward(...)` whose first argument is one
/// literal and nothing else. A concatenation, a template literal with `${`
/// and a Python f-string are built at run time and not matched.
fn judge_reference_patterns() -> &'static (regex::Regex, regex::Regex) {
    static PATTERNS: std::sync::OnceLock<(regex::Regex, regex::Regex)> = std::sync::OnceLock::new();
    PATTERNS.get_or_init(|| {
        let script = regex::Regex::new(
            r#"(?:^|[^\w$])recipeJudge\s*\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`$\\]*)`)\s*[,)]"#,
        )
        .expect("recipeJudge pattern");
        let python = regex::Regex::new(
            r#"(?:^|[^\w])judge_reward\s*\(\s*(?:name\s*=\s*)?(?:[rRuU]?"((?:[^"\\\n]|\\.)*)"|[rRuU]?'((?:[^'\\\n]|\\.)*)')\s*[,)]"#,
        )
        .expect("judge_reward pattern");
        (script, python)
    })
}

const SCRIPT_EXTENSIONS: [&str; 6] = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];

/// Every literal judge reference in the eval code: script files in the Vitest
/// suites and the eval lib, Python files in the Harbor suites. A line comment
/// is skipped; anything else that looks like a call is read as one.
fn eval_judge_references(layout: &EvalLayout, ctx: &CheckContext) -> Vec<JudgeReference> {
    let mut roots: Vec<(&str, bool)> = layout
        .suites
        .iter()
        .map(|suite| (suite.path.as_str(), suite.kind == EvalSuiteKind::Harbor))
        .collect();
    if let Some(lib) = layout.support_path("lib") {
        roots.push((lib, false));
    }
    let (script, python) = judge_reference_patterns();
    let mut seen = BTreeSet::new();
    let mut references = Vec::new();
    for (root, harbor) in roots {
        let prefix = format!("{root}/");
        for (path, content) in ctx
            .files
            .range(prefix.clone()..)
            .take_while(|(path, _)| path.starts_with(&prefix))
        {
            let (pattern, call, comment) = if harbor && path.ends_with(".py") {
                (python, "judge_reward", "#")
            } else if !harbor && SCRIPT_EXTENSIONS.iter().any(|ext| path.ends_with(ext)) {
                (script, "recipeJudge", "//")
            } else {
                continue;
            };
            let Some(content) = content.as_deref() else {
                continue;
            };
            if !seen.insert(path.clone()) {
                continue;
            }
            for captures in pattern.captures_iter(content) {
                let Some(literal) = captures.iter().skip(1).flatten().next() else {
                    continue;
                };
                // The match may open on the character before the call.
                let matched = captures.get(0).map_or(0, |m| m.start());
                let start = matched + content[matched..].find(call).unwrap_or(0);
                let line_start = content[..start].rfind('\n').map_or(0, |index| index + 1);
                let before = content[line_start..start].trim_start();
                if before.starts_with(comment) || before.starts_with('*') {
                    continue;
                }
                let reference = literal.as_str().trim();
                if reference.is_empty() || reference.contains('\\') {
                    continue;
                }
                references.push(JudgeReference {
                    path: path.clone(),
                    span: Span {
                        line: content[..start].matches('\n').count() + 1,
                        column: 1,
                    },
                    call,
                    reference: reference.to_owned(),
                });
            }
        }
    }
    references
}

/// Whether `introspection judges evaluate --judge` reads a reference as a
/// YAML path rather than a judge name.
fn judge_reference_is_path(reference: &str) -> bool {
    let lower = reference.to_ascii_lowercase();
    reference.starts_with('.')
        || reference.starts_with('/')
        || reference.contains('/')
        || lower.ends_with(".yaml")
        || lower.ends_with(".yml")
}

/// The `name` of every online judge in `judges/`, or `None` when a judge file
/// was not supplied or does not parse, since a name could hide there.
fn online_judge_names(ctx: &CheckContext) -> Option<BTreeSet<String>> {
    let mut names = BTreeSet::new();
    for file in ctx.child_files("judges") {
        let lower = file.to_ascii_lowercase();
        if !lower.ends_with(".yaml") && !lower.ends_with(".yml") {
            continue;
        }
        let parsed: JsonValue = serde_saphyr::from_str(ctx.content(file)?).ok()?;
        if parsed.get("type").and_then(JsonValue::as_str) == Some(spec::MISSION_JUDGE_TYPE) {
            continue;
        }
        if let Some(name) = parsed
            .get("name")
            .or_else(|| parsed.get("judge"))
            .and_then(JsonValue::as_str)
        {
            names.insert(name.to_owned());
        }
    }
    Some(names)
}

/// Warn about a literal judge name with no online judge of that name in
/// `judges/`, and a literal `recipeJudge` YAML path naming no file. Names
/// built at run time are not seen; review keeps those.
fn validate_eval_judge_references(layout: &EvalLayout, ctx: &mut CheckContext) {
    let references = eval_judge_references(layout, ctx);
    if references.is_empty() {
        return;
    }
    let names = online_judge_names(ctx);
    for reference in references {
        let JudgeReference {
            path,
            span,
            call,
            reference,
        } = reference;
        if call == "recipeJudge" && judge_reference_is_path(&reference) {
            // A path is resolved from the Recipe root, where the eval runs.
            let relative = normalize_relative(&reference);
            if reference.starts_with('/')
                || relative.split('/').any(|segment| segment == "..")
                || ctx.has_file(&relative)
            {
                continue;
            }
            ctx.push(
                EVALS_JUDGE_UNKNOWN,
                Severity::Warning,
                path.clone(),
                Some(span),
                format!("'{path}' calls recipeJudge(\"{reference}\"), but '{relative}' does not exist"),
                Some("point recipeJudge at an existing judge YAML (relative to the Recipe root), or pass an online judge's name"),
            );
            continue;
        }
        let Some(names) = &names else { continue };
        if names.contains(&reference) {
            continue;
        }
        ctx.push(
            EVALS_JUDGE_UNKNOWN,
            Severity::Warning,
            path.clone(),
            Some(span),
            format!("'{path}' calls {call}(\"{reference}\"), but judges/ has no online judge named '{reference}'"),
            Some("name an online judge defined in judges/, or define the eval's own judge in its suite"),
        );
    }
}

const EVALS_CASE_HELP: &str = "start the case file with YAML front matter: id (the file name without .md), check (code, person or later), approved_by, approved_at, approved_in, and optional approved_hash, conversation and issue";

/// The front-matter rules a case file can break on its own.
fn validate_case_fields(file: &str, id: &str, case: &spec::EvalCase, ctx: &mut CheckContext) {
    if let Some(written) = case.id.as_deref().filter(|written| *written != id) {
        ctx.error(
            EVALS_CASE_INVALID,
            file.to_owned(),
            format!(
                "case file '{file}' has id '{written}', but a case's id is its file name, '{id}'"
            ),
            Some("set id to the file name without .md, or rename the file"),
        );
    }
    if let Some(hash) = case
        .approved_hash
        .as_deref()
        .filter(|hash| !is_sha256(hash))
    {
        ctx.error(
            EVALS_CASE_INVALID,
            file.to_owned(),
            format!("case file '{file}' has approved_hash '{hash}', which is not sha256:<64 hex digits>"),
            Some("approve the case again so approved_hash is written for you, or remove it"),
        );
    }
    if let Some(issue) = case.issue.as_deref().filter(|issue| !is_uuid(issue)) {
        ctx.error(
            EVALS_CASE_INVALID,
            file.to_owned(),
            format!("case file '{file}' has issue '{issue}', which is not a UUID"),
            Some("set issue to the /v1/issues id of the hypothesis the case tests, or remove it"),
        );
    }
}

/// `sha256:` and 64 hexadecimal digits, in either case.
fn is_sha256(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .is_some_and(|hex| hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit()))
}

/// `8-4-4-4-12` hexadecimal digits, in either case.
fn is_uuid(value: &str) -> bool {
    let groups: Vec<&str> = value.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(group, len)| group.len() == len && group.chars().all(|c| c.is_ascii_hexdigit()))
}

/// The `case` of every JSON-object row in each Vitest suite's `*.eval.jsonl`
/// files, reporting rows without one. Lines that are not JSON objects are
/// left to the runner, and rows built in a `.eval.ts` are not read. Suite
/// paths may nest, so each file is read once.
fn vitest_case_rows(layout: &EvalLayout, ctx: &mut CheckContext) -> Vec<CaseImplementation> {
    let mut seen = BTreeSet::new();
    let files: Vec<(String, String)> = layout
        .suites
        .iter()
        .filter(|suite| suite.kind == EvalSuiteKind::Vitest)
        .flat_map(|suite| {
            let prefix = format!("{}/", suite.path);
            ctx.files
                .range(prefix.clone()..)
                .take_while(move |(path, _)| path.starts_with(&prefix))
                .filter(|(path, _)| path.ends_with(".eval.jsonl"))
                .filter_map(|(path, content)| Some((path.clone(), content.clone()?)))
        })
        .filter(|(path, _)| seen.insert(path.clone()))
        .collect();
    let mut rows = Vec::new();
    for (file, content) in files {
        for (index, line) in content.lines().enumerate() {
            let Ok(JsonValue::Object(row)) = serde_json::from_str::<JsonValue>(line.trim()) else {
                continue;
            };
            let span = Some(Span {
                line: index + 1,
                column: 1,
            });
            let label = format!("row {} of '{file}'", index + 1);
            match row.get("case").and_then(JsonValue::as_str).map(str::trim) {
                Some(case) if !case.is_empty() => rows.push(CaseImplementation {
                    case: case.to_owned(),
                    path: file.clone(),
                    span,
                    label,
                }),
                _ => ctx.push(
                    EVALS_CASE_ROW_MISSING_ID,
                    Severity::Error,
                    file.clone(),
                    span,
                    format!("{label} has no case"),
                    Some("add \"case\": \"<id>\" naming its evals/cases/<id>.md; schema_version 3 requires it"),
                ),
            }
        }
    }
    rows
}

/// Each Harbor task's case: `[metadata] case` in its `task.toml`, or else the
/// folder name. A task whose `task.toml` content was not supplied is skipped.
fn harbor_case_tasks(layout: &EvalLayout, ctx: &CheckContext) -> Vec<CaseImplementation> {
    let mut tasks = Vec::new();
    let mut seen = BTreeSet::new();
    for suite in layout
        .suites
        .iter()
        .filter(|suite| suite.kind == EvalSuiteKind::Harbor)
    {
        for task in ctx.child_dirs(&suite.path) {
            if !seen.insert(task.clone()) {
                continue;
            }
            let Some(content) = ctx.content(&format!("{task}/task.toml")) else {
                continue;
            };
            let folder = task.rsplit('/').next().unwrap_or(&task).to_owned();
            let (case, label) = match toml_metadata_case(content) {
                Some(case) => (case, format!("Harbor task '{task}' ([metadata] case)")),
                None => (folder, format!("Harbor task '{task}' (by its folder name)")),
            };
            tasks.push(CaseImplementation {
                case,
                path: task.clone(),
                span: None,
                label,
            });
        }
    }
    tasks
}

/// `case` in a `task.toml`'s `[metadata]` table (or a root `metadata.case`),
/// as a basic or literal string. A line reader, not a TOML parser: it does
/// not see an inline `metadata = { case = ... }` table.
fn toml_metadata_case(content: &str) -> Option<String> {
    let mut table = String::new();
    for line in content.lines() {
        let line = line.trim();
        if let Some(header) = line.strip_prefix('[') {
            table = header
                .trim_start_matches('[')
                .split(']')
                .next()
                .unwrap_or_default()
                .trim()
                .to_owned();
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key: String = key
            .split('.')
            .map(|part| part.trim().trim_matches(|c| c == '"' || c == '\''))
            .collect::<Vec<_>>()
            .join(".");
        let named =
            (table == "metadata" && key == "case") || (table.is_empty() && key == "metadata.case");
        if named {
            return toml_string(value.trim()).filter(|case| !case.trim().is_empty());
        }
    }
    None
}

/// A one-line TOML basic (`"..."`) or literal (`'...'`) string.
fn toml_string(value: &str) -> Option<String> {
    if let Some(rest) = value.strip_prefix('\'') {
        return rest.split_once('\'').map(|(text, _)| text.to_owned());
    }
    let rest = value.strip_prefix('"')?;
    let mut text = String::new();
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(text),
            '\\' => match chars.next()? {
                'n' => text.push('\n'),
                't' => text.push('\t'),
                other => text.push(other),
            },
            other => text.push(other),
        }
    }
    None
}

fn toml_has_verifier_table(content: &str) -> bool {
    content.lines().any(|line| {
        let line = line.trim();
        line.starts_with("[verifier]") || line.starts_with("[verifier.")
    })
}

/// One `.recipeignore` rule, in the runtime materializer's small ordered
/// language: `#` comments, `!` negation, a trailing `/` for directories only,
/// and slash-free patterns that match any path segment.
#[derive(Debug, Clone)]
struct RecipeIgnorePattern {
    negated: bool,
    directory_only: bool,
    pattern: String,
}

fn parse_recipe_ignore(content: &str) -> Vec<RecipeIgnorePattern> {
    content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| {
            let (negated, rest) = line
                .strip_prefix('!')
                .map_or((false, line), |rest| (true, rest));
            let marked = rest.trim_start_matches('/');
            let pattern = marked.trim_end_matches('/');
            (!pattern.is_empty()).then(|| RecipeIgnorePattern {
                negated,
                directory_only: marked.ends_with('/'),
                pattern: pattern.to_owned(),
            })
        })
        .collect()
}

fn recipe_ignore_matches(path: &str, directory: bool, patterns: &[RecipeIgnorePattern]) -> bool {
    let mut ignored = false;
    for rule in patterns {
        if rule.directory_only && !directory {
            continue;
        }
        let matched = if rule.pattern.contains('/') {
            glob_matches(&rule.pattern, path) || glob_matches(&format!("**/{}", rule.pattern), path)
        } else {
            path.split('/')
                .any(|segment| segment_match(&rule.pattern, segment))
        };
        if matched {
            ignored = !rule.negated;
        }
    }
    ignored
}

/// Whether the runtime prunes directory `path`: it or one of its ancestors is
/// ignored. The runtime removes an ignored directory without visiting its
/// children, so a later negation cannot bring a child back.
fn recipe_ignore_excludes_dir(path: &str, patterns: &[RecipeIgnorePattern]) -> bool {
    let segments: Vec<&str> = path.split('/').collect();
    (1..=segments.len())
        .any(|end| recipe_ignore_matches(&segments[..end].join("/"), true, patterns))
}

fn resource_patterns(
    key: &'static str,
    value: Option<&JsonValue>,
    required: bool,
    ctx: &mut CheckContext,
) -> ResourcePatterns {
    match value {
        Some(JsonValue::Array(items)) => {
            let mut patterns = Vec::with_capacity(items.len());
            let mut seen = BTreeSet::new();
            for (index, item) in items.iter().enumerate() {
                match string_value(Some(item)) {
                    Some(pattern) => {
                        if !seen.insert(pattern.clone()) {
                            ctx.error(
                                format!("pi.{key}_duplicate"),
                                PACKAGE_JSON,
                                format!(
                                    "package.json#pi.{key} contains duplicate entry '{pattern}'"
                                ),
                                Some("remove duplicate entries"),
                            );
                        }
                        patterns.push(pattern);
                    }
                    None => ctx.error(
                        format!("pi.{key}_invalid"),
                        PACKAGE_JSON,
                        format!("package.json#pi.{key}[{index}] must be a non-empty string"),
                        Some("remove the entry or replace it with a relative resource path"),
                    ),
                }
            }
            ResourcePatterns {
                explicit: true,
                patterns,
            }
        }
        Some(_) => {
            ctx.error(
                format!("pi.{key}_invalid"),
                PACKAGE_JSON,
                format!("package.json#pi.{key} must be an array of strings"),
                Some("use a list of relative resource paths"),
            );
            ResourcePatterns {
                explicit: true,
                patterns: Vec::new(),
            }
        }
        None => {
            let patterns = if required || key != "extensions" {
                if ctx.path_exists(key) {
                    vec![key.to_owned()]
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            };
            ResourcePatterns {
                explicit: false,
                patterns,
            }
        }
    }
}

fn resolve_resource_patterns(
    key: &'static str,
    patterns: &ResourcePatterns,
    required: bool,
    ctx: &mut CheckContext,
) -> Vec<String> {
    let mut resolved = BTreeSet::new();
    for pattern in &patterns.patterns {
        if let Err(message) = validate_relative_pattern(pattern) {
            ctx.error(
                format!("package.{key}_invalid"),
                PACKAGE_JSON,
                message,
                Some("use paths relative to the recipe directory"),
            );
            continue;
        }

        let matches = match_paths(ctx, pattern);
        if matches.is_empty() && (required || patterns.explicit) {
            ctx.error(
                format!("package.{key}_unmatched"),
                PACKAGE_JSON,
                format!("package.json#pi.{key} pattern '{pattern}' matched no files"),
                Some("update or remove the unmatched resource pattern"),
            );
        }
        for path in matches {
            if key == "extensions" {
                let entries = resolve_extension_entry(ctx, &path);
                if entries.is_empty() {
                    ctx.error(
                        "package.extensions_non_loadable",
                        path.clone(),
                        format!(
                            "package.json#pi.extensions pattern '{pattern}' matched no loadable extension modules"
                        ),
                        Some(
                            "point extension patterns at modules or directories with an index, direct modules, or indexed child directories",
                        ),
                    );
                }
                resolved.extend(entries);
            } else {
                resolved.insert(path);
            }
        }
    }

    if required && !patterns.explicit && patterns.patterns.is_empty() {
        ctx.error(
            "package.agents_missing",
            PACKAGE_JSON,
            "Recipe has no package.json#pi.agents and no conventional agents directory",
            Some("add agents/*.yaml or configure package.json#pi.agents"),
        );
    }

    resolved.into_iter().collect()
}

fn resolve_agents(
    resources: &HashMap<&'static str, Vec<String>>,
    ctx: &CheckContext,
) -> Vec<String> {
    let mut agents = BTreeSet::new();
    for path in resources.get("agents").into_iter().flatten() {
        if ctx.has_file(path) {
            if is_yaml_path(path) {
                agents.insert(path.clone());
            }
        } else if ctx.has_dir(path) {
            for child in ctx.child_files(path) {
                if is_yaml_path(child) {
                    agents.insert(child.to_owned());
                }
            }
        }
    }
    agents.into_iter().collect()
}

/// Skills the Recipe's direct `dependencies` and `peerDependencies` declare with `pi.skills`, read
/// from `node_modules/<name>` in the snapshot.
#[derive(Debug, Default)]
struct DependencySkills {
    /// Resource paths (snapshot-relative) each declaring package resolved to.
    resources: Vec<String>,
    /// Roots (`node_modules/<name>`) of the dependencies that declare `pi.skills`.
    /// A `SKILL.md` directly in one is named `skill` when it has no frontmatter
    /// name, as the runtime names it, not after the dependency's folder.
    roots: Vec<String>,
    /// Direct dependencies whose `package.json` the snapshot does not hold.
    /// A snapshot usually leaves `node_modules` out, so their skills are unknown.
    uninstalled: Vec<String>,
}

const DEPENDENCY_SKILLS_INVALID: &str = "dependency.skills_invalid";

/// Resolve the `pi.skills` of each direct `dependencies` or `peerDependencies`
/// entry installed in the snapshot's `node_modules` (a peer is provided by the
/// platform). Dev and transitive dependencies are not read, and only an explicit `pi.skills` counts: a dependency's `skills/`
/// folder is not discovered by convention.
fn resolve_dependency_skills(package: &Package, ctx: &mut CheckContext) -> DependencySkills {
    let mut found = DependencySkills::default();
    // The host's own imports (Recipes, Pi) ship no skills, and a snapshot
    // rarely holds them, so they never make a skill unverifiable.
    let peers = package
        .peer_dependencies
        .iter()
        .filter(|name| !HOST_PEER_PACKAGES.contains(&name.as_str()));
    let names: BTreeSet<&String> = package.dependencies.iter().chain(peers).collect();
    for name in names {
        let root = format!("node_modules/{name}");
        let manifest_path = format!("{root}/package.json");
        let Some(content) = ctx.content(&manifest_path).map(str::to_owned) else {
            found.uninstalled.push(name.clone());
            continue;
        };
        let pi_skills = serde_json::from_str::<JsonValue>(&content)
            .ok()
            .and_then(|manifest| manifest.get("pi")?.get("skills").cloned());
        let Some(pi_skills) = pi_skills else {
            continue;
        };
        found.roots.push(root.clone());
        let Some(patterns) = pi_skills.as_array().and_then(|items| {
            items
                .iter()
                .map(|item| string_value(Some(item)))
                .collect::<Option<Vec<_>>>()
        }) else {
            ctx.error(
                DEPENDENCY_SKILLS_INVALID,
                manifest_path,
                format!("dependency '{name}' package.json#pi.skills must be an array of non-empty strings"),
                Some("fix the dependency's package.json or remove it from dependencies"),
            );
            continue;
        };
        for pattern in patterns {
            if let Err(message) = validate_relative_pattern(&pattern) {
                ctx.error(
                    DEPENDENCY_SKILLS_INVALID,
                    manifest_path.clone(),
                    format!("dependency '{name}' package.json#pi.skills: {message}"),
                    Some("skill paths must stay inside the dependency package"),
                );
                continue;
            }
            let pattern = pattern.trim().trim_start_matches("./");
            let matches = match_paths(ctx, &format!("{root}/{pattern}"));
            if matches.is_empty() {
                ctx.error(
                    "dependency.skills_unmatched",
                    manifest_path.clone(),
                    format!("dependency '{name}' package.json#pi.skills pattern '{pattern}' matched no files"),
                    Some("every explicit pi.skills path must match; fix or upgrade the dependency"),
                );
            }
            found.resources.extend(matches);
        }
    }
    found
}

fn validate_agents(
    agent_paths: &[String],
    resources: &HashMap<&'static str, Vec<String>>,
    dependency_skills: &DependencySkills,
    mcp_tool_policy: Option<&McpToolPolicy>,
    ctx: &mut CheckContext,
) {
    let mut sources = Vec::new();
    for path in agent_paths {
        if let Some(agent) = read_agent(path, ctx) {
            sources.push(agent);
        }
    }
    if sources.is_empty() {
        return;
    }

    validate_agent_names(&sources, ctx);

    let mut raw_by_name = HashMap::new();
    for source in &sources {
        raw_by_name.insert(source.name.clone(), source);
    }

    let mut unique_names: Vec<String> = raw_by_name.keys().cloned().collect();
    unique_names.sort();
    let skill_resources: Vec<String> = resources
        .get("skills")
        .into_iter()
        .flatten()
        .chain(&dependency_skills.resources)
        .cloned()
        .collect();
    let skill_names = packaged_skill_names(&skill_resources, &dependency_skills.roots, ctx);
    for name in unique_names {
        validate_agent_inheritance(&name, &raw_by_name, ctx);
        for field in AgentField::REQUIRED {
            if !resolved_field_provided(&name, field, &raw_by_name, &mut Vec::new()) {
                let path = raw_by_name
                    .get(&name)
                    .map(|agent| agent.path.clone())
                    .unwrap_or_default();
                ctx.error(
                    format!("agent.{}_missing", field.label()),
                    path,
                    format!(
                        "Recipe agent '{name}' must declare {} directly or inherit it with from",
                        field.label()
                    ),
                    field.help(),
                );
            }
        }
        if let Some(agent) = raw_by_name.get(&name) {
            validate_declared_agent_references(
                agent,
                &raw_by_name,
                &skill_names,
                &dependency_skills.uninstalled,
                ctx,
            );
        }
        validate_resolved_agent_mcp(&name, &raw_by_name, mcp_tool_policy, ctx);
    }
}

fn read_agent(path: &str, ctx: &mut CheckContext) -> Option<RawAgent> {
    let Some(content) = ctx.content(path).map(str::to_owned) else {
        ctx.error(
            "agent.unreadable",
            path,
            "Agent YAML content was not provided",
            Some("supply agent YAML content to the validator"),
        );
        return None;
    };
    let parsed: JsonValue = match serde_saphyr::from_str(&content) {
        Ok(value) => value,
        Err(err) => {
            let message = err.to_string();
            let span = span_from_message(&message);
            ctx.error_at(
                "agent.yaml_malformed",
                path,
                span,
                format!("Agent file is not valid YAML: {message}"),
                Some("fix the YAML syntax"),
            );
            return None;
        }
    };
    let Some(map) = parsed.as_object() else {
        ctx.error(
            "agent.invalid",
            path,
            "Agent file must contain a YAML object",
            Some("make the top-level YAML value a mapping"),
        );
        return None;
    };
    const AGENT_KEYS: &[&str] = &[
        "name",
        "from",
        "description",
        "model",
        "ai",
        "session",
        "tools",
        "mcp",
        "skills",
        "phases",
        "subagents",
        "system_instructions",
    ];
    for key in map.keys().filter(|key| !AGENT_KEYS.contains(&key.as_str())) {
        ctx.error(
            "agent.key_unknown",
            path,
            format!("Agent contains unknown field '{key}'"),
            Some(format!("supported fields: {}", AGENT_KEYS.join(", "))),
        );
    }

    let name = match map.get("name") {
        Some(JsonValue::String(name)) if !name.trim().is_empty() => name.clone(),
        Some(JsonValue::String(_)) | None => {
            ctx.error(
                "agent.name_missing",
                path,
                "Agent must declare a non-empty name",
                Some("set name to the stable identity used by references and telemetry"),
            );
            return None;
        }
        Some(_) => {
            ctx.error(
                "agent.name_invalid",
                path,
                "Agent name must be a string",
                Some("set name to the stable identity used by references and telemetry"),
            );
            return None;
        }
    };
    if !portable_agent_name(&name) {
        ctx.error(
            "agent.name_invalid",
            path,
            "Agent name must use lowercase kebab-case",
            Some("use lowercase letters and numbers separated by single hyphens"),
        );
    }

    if map.contains_key("description")
        && !matches!(map.get("description"), Some(JsonValue::String(_)))
    {
        ctx.error(
            "agent.description_invalid",
            path,
            "Agent description must be a string",
            Some("remove description or provide a string"),
        );
    }

    let from = match map.get("from") {
        Some(JsonValue::String(value)) if !value.trim().is_empty() => {
            let value = value.to_owned();
            if !portable_agent_name(&value) {
                ctx.error(
                    "agent.from_invalid",
                    path,
                    "Agent from must use lowercase kebab-case",
                    Some("reference an agent by its portable name"),
                );
            }
            Some(value)
        }
        Some(_) => {
            ctx.error(
                "agent.from_invalid",
                path,
                "Agent from must be a non-empty string",
                Some("remove the field or reference an existing agent"),
            );
            None
        }
        None => None,
    };

    let mut fields = HashSet::new();
    if map.contains_key("model") && map.contains_key("ai") {
        ctx.error(
            "agent.ai_model_conflict",
            path,
            "Agent must not declare both ai and model",
            Some("use ai; model is retained only for backwards compatibility"),
        );
    }
    validate_agent_model(map, path, &name, &mut fields, ctx);
    validate_agent_ai(map, path, &name, &mut fields, ctx);
    validate_agent_session(map, path, ctx);
    let tools = validate_agent_string_array(map, "tools", path, ctx);
    let reserved_tools = tools
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter(|tool| tool.as_str() == "agent")
        .cloned()
        .collect::<Vec<_>>();
    if !reserved_tools.is_empty() {
        ctx.error(
            "agent.tools_reserved",
            path,
            format!(
                "Agent tools must not declare session-generated tools: {}",
                reserved_tools.join(", ")
            ),
            Some("remove the generated tool from the tools list"),
        );
    }
    let mcp = validate_agent_mcp(map, path, ctx);
    let skills = validate_agent_string_array(map, "skills", path, ctx);
    validate_agent_string_array(map, "phases", path, ctx);
    let subagents = validate_agent_string_array(map, "subagents", path, ctx);
    validate_agent_system_instructions(map, path, ctx);

    Some(RawAgent {
        name,
        path: path.to_owned(),
        from,
        fields,
        skills,
        subagents,
        tools,
        mcp,
    })
}

fn validate_agent_model(
    map: &JsonMap,
    path: &str,
    name: &str,
    fields: &mut HashSet<AgentField>,
    ctx: &mut CheckContext,
) {
    let Some(value) = map.get("model") else {
        return;
    };
    let Some(model) = value.as_object() else {
        ctx.error(
            "agent.model_invalid",
            path,
            "Agent model must be an object",
            Some("make model a mapping of supported model settings"),
        );
        return;
    };
    const MODEL_KEYS: &[&str] = &[
        "name",
        "thinking_level",
        "temperature",
        "max_tokens",
        "cache_retention",
        "timeout_ms",
        "max_retries",
        "max_retry_delay_ms",
        "providers",
    ];
    for key in model
        .keys()
        .filter(|key| !MODEL_KEYS.contains(&key.as_str()))
    {
        ctx.error(
            "agent.model_key_unknown",
            path,
            format!("Agent model contains unknown field '{key}'"),
            Some(format!("supported fields: {}", MODEL_KEYS.join(", "))),
        );
    }

    if let Some(model_name) = obj_string(model, "name") {
        fields.insert(AgentField::ModelName);
        if !valid_model_spec(&model_name) {
            ctx.error(
                "agent.model.name_invalid",
                path,
                format!(
                    "Recipe agent '{name}' has invalid model.name '{model_name}' - expected '<provider>/<model_id>'"
                ),
                Some("use an available provider and model identifier"),
            );
        }
    } else if model.contains_key("name") {
        ctx.error(
            "agent.model.name_invalid",
            path,
            "Agent model.name must be a non-empty string",
            Some("set an available provider and model identifier"),
        );
    }

    if let Some(value) = model.get("thinking_level") {
        let valid = value.as_str().is_some_and(|level| {
            matches!(
                level,
                "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
            )
        });
        if !valid {
            ctx.error(
                "agent.model.thinking_level_invalid",
                path,
                "Agent model.thinking_level is unsupported",
                Some("use off, minimal, low, medium, high, xhigh, or max"),
            );
        }
    }
    validate_non_negative_number(model, "temperature", false, path, ctx);
    validate_non_negative_number(model, "max_tokens", true, path, ctx);
    validate_non_negative_number(model, "timeout_ms", true, path, ctx);
    validate_non_negative_number(model, "max_retries", false, path, ctx);
    validate_non_negative_number(model, "max_retry_delay_ms", false, path, ctx);
    if let Some(value) = model.get("cache_retention") {
        if !value
            .as_str()
            .is_some_and(|retention| matches!(retention, "none" | "short" | "long"))
        {
            ctx.error(
                "agent.model.cache_retention_invalid",
                path,
                "Agent model.cache_retention is unsupported",
                Some("use none, short, or long"),
            );
        }
    }
    validate_model_providers(model.get("providers"), path, ctx, false);
}

fn snake_case_key(value: &str) -> bool {
    let mut chars = value.chars();
    if !chars.next().is_some_and(|ch| ch.is_ascii_lowercase()) {
        return false;
    }
    let mut previous_underscore = false;
    for ch in chars {
        if ch == '_' {
            if previous_underscore {
                return false;
            }
            previous_underscore = true;
        } else if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            previous_underscore = false;
        } else {
            return false;
        }
    }
    !previous_underscore
}

fn validate_agent_ai(
    map: &JsonMap,
    path: &str,
    name: &str,
    fields: &mut HashSet<AgentField>,
    ctx: &mut CheckContext,
) {
    let Some(value) = map.get("ai") else { return };
    let Some(ai) = value.as_object() else {
        ctx.error(
            "agent.ai_invalid",
            path,
            "Agent ai must be an object",
            None::<String>,
        );
        return;
    };
    const AI_KEYS: &[&str] = &["model", "thinking_level", "options", "providers"];
    for key in ai.keys().filter(|key| !AI_KEYS.contains(&key.as_str())) {
        ctx.error(
            "agent.ai_key_unknown",
            path,
            format!("Agent ai contains unknown field '{key}'"),
            Some(format!("supported fields: {}", AI_KEYS.join(", "))),
        );
    }
    if let Some(model_name) = obj_string(ai, "model") {
        fields.insert(AgentField::ModelName);
        if !valid_model_spec(&model_name) {
            ctx.error(
                "agent.ai.model_invalid",
                path,
                format!("Recipe agent '{name}' has invalid ai.model '{model_name}' - expected '<provider>/<model_id>'"),
                Some("use an available provider and model identifier"),
            );
        }
    } else if ai.contains_key("model") {
        ctx.error(
            "agent.ai.model_invalid",
            path,
            "Agent ai.model must be a non-empty string",
            None::<String>,
        );
    }
    if let Some(value) = ai.get("thinking_level") {
        if !value.as_str().is_some_and(|level| {
            matches!(
                level,
                "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
            )
        }) {
            ctx.error(
                "agent.ai.thinking_level_invalid",
                path,
                "Agent ai.thinking_level is unsupported",
                Some("use off, minimal, low, medium, high, xhigh, or max"),
            );
        }
    }
    if let Some(value) = ai.get("options") {
        let Some(options) = value.as_object() else {
            ctx.error(
                "agent.ai.options_invalid",
                path,
                "Agent ai.options must be an object",
                None::<String>,
            );
            return;
        };
        const BLOCKED: &[&str] = &[
            "api_key",
            "azure_api_version",
            "azure_base_url",
            "azure_deployment_name",
            "azure_resource_name",
            "bearer_token",
            "client",
            "env",
            "fetch",
            "headers",
            "location",
            "on_payload",
            "on_response",
            "profile",
            "project",
            "reasoning",
            "region",
            "session_id",
            "signal",
            "telemetry_context",
            "transform_headers",
        ];
        for key in options.keys() {
            if !snake_case_key(key) {
                ctx.error(
                    "agent.ai.options_key_invalid",
                    path,
                    format!("Agent ai.options key '{key}' must use snake_case"),
                    None::<String>,
                );
            } else if BLOCKED.contains(&key.as_str()) {
                ctx.error(
                    "agent.ai.options_key_blocked",
                    path,
                    format!("Agent ai.options cannot configure host-owned option '{key}'"),
                    None::<String>,
                );
            }
        }
    }
    validate_model_providers(ai.get("providers"), path, ctx, true);
}

fn validate_agent_session(map: &JsonMap, path: &str, ctx: &mut CheckContext) {
    let Some(value) = map.get("session") else {
        return;
    };
    let Some(session) = value.as_object() else {
        ctx.error(
            "agent.session_invalid",
            path,
            "Agent session must be an object",
            None::<String>,
        );
        return;
    };
    const SESSION_KEYS: &[&str] = &[
        "steering_mode",
        "follow_up_mode",
        "tool_execution",
        "retry",
        "compaction",
        "images",
    ];
    for key in session
        .keys()
        .filter(|key| !SESSION_KEYS.contains(&key.as_str()))
    {
        ctx.error(
            "agent.session_key_unknown",
            path,
            format!("Agent session contains unknown field '{key}'"),
            Some(format!("supported fields: {}", SESSION_KEYS.join(", "))),
        );
    }
    for key in ["steering_mode", "follow_up_mode"] {
        if let Some(value) = session.get(key) {
            if !value
                .as_str()
                .is_some_and(|mode| matches!(mode, "all" | "one-at-a-time"))
            {
                ctx.error(
                    format!("agent.session.{key}_invalid"),
                    path,
                    format!("Agent session.{key} must be all or one-at-a-time"),
                    None::<String>,
                );
            }
        }
    }
    if let Some(value) = session.get("tool_execution") {
        if !value
            .as_str()
            .is_some_and(|mode| matches!(mode, "parallel" | "sequential"))
        {
            ctx.error(
                "agent.session.tool_execution_invalid",
                path,
                "Agent session.tool_execution must be parallel or sequential",
                None::<String>,
            );
        }
    }
    if let Some(value) = session.get("retry") {
        validate_session_retry(value, path, ctx);
    }
    if let Some(value) = session.get("compaction") {
        validate_session_settings_object(
            value,
            path,
            "compaction",
            &["enabled", "reserve_tokens", "keep_recent_tokens"],
            &["enabled"],
            &[("reserve_tokens", false), ("keep_recent_tokens", false)],
            ctx,
        );
    }
    if let Some(value) = session.get("images") {
        validate_session_settings_object(
            value,
            path,
            "images",
            &["auto_resize", "block_images"],
            &["auto_resize", "block_images"],
            &[],
            ctx,
        );
    }
}

fn validate_session_retry(value: &JsonValue, path: &str, ctx: &mut CheckContext) {
    let Some(retry) = validate_session_settings_object(
        value,
        path,
        "retry",
        &[
            "enabled",
            "max_retries",
            "base_delay_ms",
            "max_agent_delay_ms",
            "provider",
        ],
        &["enabled"],
        &[
            ("max_retries", false),
            ("base_delay_ms", false),
            ("max_agent_delay_ms", false),
        ],
        ctx,
    ) else {
        return;
    };
    if let Some(provider) = retry.get("provider") {
        validate_session_settings_object(
            provider,
            path,
            "retry.provider",
            &["timeout_ms", "max_retries", "max_retry_delay_ms"],
            &[],
            &[
                ("timeout_ms", true),
                ("max_retries", false),
                ("max_retry_delay_ms", false),
            ],
            ctx,
        );
    }
}

fn validate_session_settings_object<'a>(
    value: &'a JsonValue,
    path: &str,
    section: &str,
    allowed_keys: &[&str],
    boolean_keys: &[&str],
    integer_keys: &[(&str, bool)],
    ctx: &mut CheckContext,
) -> Option<&'a JsonMap> {
    let prefix = format!("session.{section}");
    let Some(settings) = value.as_object() else {
        ctx.error(
            format!("agent.{prefix}_invalid"),
            path,
            format!("Agent {prefix} must be an object"),
            None::<String>,
        );
        return None;
    };
    for key in settings
        .keys()
        .filter(|key| !allowed_keys.contains(&key.as_str()))
    {
        ctx.error(
            format!("agent.{prefix}_key_unknown"),
            path,
            format!("Agent {prefix} contains unknown field '{key}'"),
            Some(format!("supported fields: {}", allowed_keys.join(", "))),
        );
    }
    for key in boolean_keys {
        if settings.get(*key).is_some_and(|value| !value.is_boolean()) {
            ctx.error(
                format!("agent.{prefix}.{key}_invalid"),
                path,
                format!("Agent {prefix}.{key} must be a boolean"),
                None::<String>,
            );
        }
    }
    for (key, strictly_positive) in integer_keys {
        let Some(value) = settings.get(*key) else {
            continue;
        };
        let minimum = if *strictly_positive { 1.0 } else { 0.0 };
        let valid = value.as_f64().is_some_and(|number| {
            number.is_finite()
                && number >= minimum
                && number <= 9_007_199_254_740_991.0
                && number.fract() == 0.0
        });
        if !valid {
            ctx.error(
                format!("agent.{prefix}.{key}_invalid"),
                path,
                format!(
                    "Agent {prefix}.{key} must be an integer >= {}",
                    minimum as u8
                ),
                None::<String>,
            );
        }
    }
    Some(settings)
}

fn validate_non_negative_number(
    model: &JsonMap,
    key: &str,
    strictly_positive: bool,
    path: &str,
    ctx: &mut CheckContext,
) {
    let Some(value) = model.get(key) else {
        return;
    };
    let valid = value.as_f64().is_some_and(|number| {
        number.is_finite()
            && if strictly_positive {
                number >= 1.0 && number.fract() == 0.0
            } else if key == "temperature" {
                number >= 0.0
            } else {
                number >= 0.0 && number.fract() == 0.0
            }
    });
    if !valid {
        ctx.error(
            format!("agent.model.{key}_invalid"),
            path,
            format!(
                "Agent model.{key} must be {}",
                if strictly_positive {
                    "an integer >= 1"
                } else if key == "temperature" {
                    "a number >= 0"
                } else {
                    "an integer >= 0"
                }
            ),
            None::<String>,
        );
    }
}

fn validate_model_providers(
    value: Option<&JsonValue>,
    path: &str,
    ctx: &mut CheckContext,
    transparent_provider_payloads: bool,
) {
    let Some(value) = value else {
        return;
    };
    let Some(providers) = value.as_object() else {
        ctx.error(
            "agent.model.providers_invalid",
            path,
            "Agent model.providers must be an object",
            None::<String>,
        );
        return;
    };
    for key in providers.keys().filter(|key| {
        let known = match key.as_str() {
            "openrouter" | "anthropic" => true,
            "vercel_ai_gateway" => transparent_provider_payloads,
            _ => false,
        };
        !known
    }) {
        ctx.error(
            "agent.model.providers_key_unknown",
            path,
            format!("Agent model.providers contains unknown field '{key}'"),
            Some(if transparent_provider_payloads {
                "use only openrouter, anthropic, and vercel_ai_gateway"
            } else {
                "use only openrouter and anthropic"
            }),
        );
    }
    if let Some(value) = providers.get("openrouter") {
        let Some(openrouter) = value.as_object() else {
            ctx.error(
                "agent.model.providers.openrouter_invalid",
                path,
                "Agent model.providers.openrouter must be an object",
                None::<String>,
            );
            return;
        };
        for key in openrouter.keys().filter(|key| key.as_str() != "routing") {
            ctx.error(
                "agent.model.providers.openrouter_key_unknown",
                path,
                format!("Agent model.providers.openrouter contains unknown field '{key}'"),
                Some("use only routing"),
            );
        }
        if let Some(value) = openrouter.get("routing") {
            validate_openrouter_routing(value, path, ctx, transparent_provider_payloads);
        }
    }
    if let Some(value) = providers.get("anthropic") {
        let Some(anthropic) = value.as_object() else {
            ctx.error(
                "agent.model.providers.anthropic_invalid",
                path,
                "Agent model.providers.anthropic must be an object",
                None::<String>,
            );
            return;
        };
        for key in anthropic
            .keys()
            .filter(|key| !matches!(key.as_str(), "betas" | "context_management"))
        {
            ctx.error(
                "agent.model.providers.anthropic_key_unknown",
                path,
                format!("Agent model.providers.anthropic contains unknown field '{key}'"),
                Some("use only betas and context_management"),
            );
        }
        if let Some(value) = anthropic.get("betas") {
            if string_array(value).is_err() {
                ctx.error(
                    "agent.model.providers.anthropic_betas_invalid",
                    path,
                    "Agent model.providers.anthropic.betas must be an array of non-empty strings",
                    None::<String>,
                );
            }
        }
        if anthropic
            .get("context_management")
            .is_some_and(|value| !value.is_object())
        {
            ctx.error(
                "agent.model.providers.anthropic_context_management_invalid",
                path,
                "Agent model.providers.anthropic.context_management must be an object",
                None::<String>,
            );
        }
    }
    if transparent_provider_payloads {
        if let Some(value) = providers.get("vercel_ai_gateway") {
            let Some(vercel) = value.as_object() else {
                ctx.error(
                    "agent.ai.providers.vercel_ai_gateway_invalid",
                    path,
                    "Agent ai.providers.vercel_ai_gateway must be an object",
                    None::<String>,
                );
                return;
            };
            for key in vercel.keys().filter(|key| key.as_str() != "routing") {
                ctx.error(
                    "agent.ai.providers.vercel_ai_gateway_key_unknown",
                    path,
                    format!("Agent ai.providers.vercel_ai_gateway contains unknown field '{key}'"),
                    Some("use only routing"),
                );
            }
            if let Some(value) = vercel.get("routing") {
                let Some(routing) = value.as_object() else {
                    ctx.error(
                        "agent.ai.providers.vercel_ai_gateway.routing_invalid",
                        path,
                        "Agent ai.providers.vercel_ai_gateway.routing must be an object",
                        None::<String>,
                    );
                    return;
                };
                if routing.contains_key("byok") {
                    ctx.error(
                        "agent.ai.providers.vercel_ai_gateway.routing_key_blocked",
                        path,
                        "Agent ai.providers.vercel_ai_gateway.routing cannot configure host-owned field 'byok'",
                        None::<String>,
                    );
                }
            }
        }
    }
}

fn validate_openrouter_routing(
    value: &JsonValue,
    path: &str,
    ctx: &mut CheckContext,
    transparent: bool,
) {
    const ROUTING_KEYS: &[&str] = &[
        "allow_fallbacks",
        "require_parameters",
        "data_collection",
        "zdr",
        "enforce_distillable_text",
        "order",
        "only",
        "ignore",
        "quantizations",
        "sort",
        "max_price",
        "preferred_min_throughput",
        "preferred_max_latency",
    ];
    let Some(routing) = value.as_object() else {
        ctx.error(
            "agent.model.providers.openrouter.routing_invalid",
            path,
            "Agent model.providers.openrouter.routing must be an object",
            None::<String>,
        );
        return;
    };
    if transparent {
        return;
    }
    for key in routing
        .keys()
        .filter(|key| !ROUTING_KEYS.contains(&key.as_str()))
    {
        ctx.error(
            "agent.model.providers.openrouter.routing_key_unknown",
            path,
            format!("Agent OpenRouter routing contains unknown field '{key}'"),
            Some(format!("supported fields: {}", ROUTING_KEYS.join(", "))),
        );
    }
}

fn validate_agent_string_array(
    map: &JsonMap,
    key: &'static str,
    path: &str,
    ctx: &mut CheckContext,
) -> Option<Vec<String>> {
    let value = map.get(key)?;
    match string_array(value) {
        Ok(()) => {
            let values: Vec<String> = value
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(JsonValue::as_str)
                .map(str::trim)
                .map(str::to_owned)
                .collect();
            let unique: BTreeSet<&str> = values.iter().map(String::as_str).collect();
            if unique.len() != values.len() {
                ctx.error(
                    format!("agent.{key}_duplicate"),
                    path,
                    format!("Agent {key} must not contain duplicate entries"),
                    Some("remove duplicate entries"),
                );
            }
            Some(values)
        }
        Err(message) => {
            ctx.error(
                format!("agent.{key}_invalid"),
                path,
                message,
                Some("use a list containing only non-empty strings"),
            );
            None
        }
    }
}

const AGENT_MCP_SERVER_KEYS: [&str; 5] = ["include", "exclude", "defer", "eager", "behind"];

fn validate_agent_mcp(map: &JsonMap, path: &str, ctx: &mut CheckContext) -> Option<AgentMcpConfig> {
    let value = map.get("mcp")?;
    let Some(mcp) = value.as_object() else {
        ctx.error(
            "agent.mcp_invalid",
            path,
            "Agent mcp must be an object",
            Some("remove mcp for no access, or declare server policies"),
        );
        return Some(AgentMcpConfig::default());
    };
    let mode = match mcp.get("mode") {
        Some(JsonValue::String(value)) if value == "cli" => Some(AgentMcpMode::Cli),
        Some(JsonValue::String(value)) if value == "tools" => Some(AgentMcpMode::Tools),
        Some(JsonValue::String(value)) if value == "codemode" => Some(AgentMcpMode::Codemode),
        Some(_) => {
            ctx.error(
                "agent.mcp_mode_invalid",
                path,
                "Agent mcp.mode must be 'cli', 'tools' or 'codemode'",
                Some("set mcp.mode to cli, tools or codemode"),
            );
            None
        }
        None => None,
    };
    let empty_servers = JsonMap::new();
    let servers = match mcp.get("servers") {
        Some(JsonValue::Object(servers)) => servers,
        Some(_) => {
            ctx.error(
                "agent.mcp_servers_invalid",
                path,
                "Agent mcp.servers must be an object",
                Some("move server selections under mcp.servers"),
            );
            return Some(AgentMcpConfig {
                mode,
                ..AgentMcpConfig::default()
            });
        }
        None => {
            ctx.error(
                "agent.mcp_servers_invalid",
                path,
                "Agent mcp.servers is required",
                Some("declare server selections under mcp.servers"),
            );
            &empty_servers
        }
    };
    for key in mcp
        .keys()
        .filter(|key| !matches!(key.as_str(), "mode" | "servers"))
    {
        ctx.error(
            "agent.mcp_key_unknown",
            path,
            format!("Unknown Agent mcp field '{key}'"),
            Some("use only mode and servers"),
        );
    }
    let mut parsed = BTreeMap::new();
    for (server_key, value) in servers {
        if server_key.trim().is_empty() {
            ctx.error(
                "agent.mcp_server_invalid",
                path,
                "Agent mcp server ids must be non-empty strings",
                Some("remove the entry or give the server a non-empty identifier"),
            );
            continue;
        }
        let server_id = server_key.as_str();
        let Some(server) = value.as_object() else {
            ctx.error(
                "agent.mcp_invalid",
                path,
                format!("Agent mcp server '{server_id}' must be an object"),
                Some("remove the server for no access, or declare its tool policy"),
            );
            continue;
        };
        reject_unknown_mcp_server_keys(server, server_id, path, ctx);
        let mut selectors = McpToolSelectors {
            behind: validate_mcp_behind(server, server_id, path, ctx),
            ..McpToolSelectors::default()
        };
        for key in ["include", "exclude", "defer", "eager"] {
            let Some(value) = server.get(key) else {
                continue;
            };
            if matches!(key, "defer" | "eager") && mode.is_some() && !activation_allowed(key, mode)
            {
                ctx.error(
                    "agent.mcp_activation_invalid",
                    path,
                    format!(
                        "Agent mcp server '{server_id}' {key} is not valid when mcp.mode is {}",
                        mode_name(mode)
                    ),
                    Some(activation_help(key)),
                );
            }
            if let Err(message) = string_array(value) {
                ctx.error(
                    "agent.mcp_invalid",
                    path,
                    format!("mcp.{server_id}.{key}: {message}"),
                    Some("use a list containing only non-empty tool names"),
                );
                continue;
            }
            let Some(items) = value.as_array() else {
                continue;
            };
            let authored_values = items
                .iter()
                .filter_map(JsonValue::as_str)
                .map(str::trim)
                .collect::<Vec<_>>();
            if authored_values.iter().collect::<BTreeSet<_>>().len() != authored_values.len() {
                ctx.error(
                    "agent.mcp_selector_duplicate",
                    path,
                    format!("Agent mcp server '{server_id}' {key} must not contain duplicates"),
                    Some("remove duplicate selectors"),
                );
            }
            let values = items
                .iter()
                .filter_map(JsonValue::as_str)
                .map(str::trim)
                .map(str::to_owned)
                .collect::<BTreeSet<_>>();
            for selector in &values {
                let valid = match key {
                    "include" | "defer" | "eager" => {
                        !selector.is_empty() && (selector == "*" || !selector.contains('*'))
                    }
                    _ => !selector.is_empty() && !selector.contains('*'),
                };
                if !valid {
                    ctx.error(
                        "agent.mcp_selector_invalid",
                        path,
                        format!(
                            "Agent mcp server '{server_id}' {key} entry '{selector}' must be {}",
                            if matches!(key, "include" | "defer" | "eager") {
                                "an exact tool name or '*'"
                            } else {
                                "an exact tool name"
                            }
                        ),
                        None::<String>,
                    );
                }
            }
            if matches!(key, "defer" | "eager") && values.contains("*") && items.len() != 1 {
                ctx.error(
                    "agent.mcp_activation_selector_invalid",
                    path,
                    format!("Agent mcp server '{server_id}' {key} must use '*' by itself"),
                    None::<String>,
                );
            }
            match key {
                "include" => selectors.include = Some(values),
                "exclude" => selectors.exclude = Some(values),
                "defer" => selectors.defer = Some(values),
                "eager" => selectors.eager = Some(values),
                _ => unreachable!(),
            }
        }
        let normalized_server_id = safe_mcp_server_id(server_id);
        if parsed.contains_key(&normalized_server_id) {
            ctx.error(
                "agent.mcp_server_collision",
                path,
                format!(
                    "Agent mcp server '{server_id}' collides with another server after id normalization"
                ),
                Some("use server ids that remain unique after normalization"),
            );
            continue;
        }
        parsed.insert(normalized_server_id, selectors);
    }
    Some(AgentMcpConfig {
        mode,
        servers: parsed,
    })
}

fn reject_unknown_mcp_server_keys(
    server: &JsonMap,
    server_id: &str,
    path: &str,
    ctx: &mut CheckContext,
) {
    for key in server
        .keys()
        .filter(|key| !AGENT_MCP_SERVER_KEYS.contains(&key.as_str()))
    {
        ctx.error(
            "agent.mcp_key_unknown",
            path,
            format!("Agent mcp server '{server_id}' contains unknown field '{key}'"),
            Some("use only include, exclude, defer, eager, and behind"),
        );
    }
}

/// `behind` puts a server behind the named tools: a non-empty list of exact tool names, and never
/// with `defer` or `eager`, since the model is not to see the server's tools at all.
fn validate_mcp_behind(
    server: &JsonMap,
    server_id: &str,
    path: &str,
    ctx: &mut CheckContext,
) -> Option<BTreeSet<String>> {
    let value = server.get("behind")?;
    let items = match (string_array(value), value.as_array()) {
        (Ok(()), Some(items)) if !items.is_empty() => items,
        (Err(message), _) => {
            ctx.error(
                "agent.mcp_invalid",
                path,
                format!("mcp.{server_id}.behind: {message}"),
                Some("list the tools that call the server, such as [mail]"),
            );
            return None;
        }
        _ => {
            ctx.error(
                "agent.mcp_invalid",
                path,
                format!("Agent mcp server '{server_id}' behind must name at least one tool"),
                Some("list the tools that call the server, or remove behind"),
            );
            return None;
        }
    };
    let names = items
        .iter()
        .filter_map(JsonValue::as_str)
        .map(str::trim)
        .collect::<Vec<_>>();
    if names.iter().collect::<BTreeSet<_>>().len() != names.len() {
        ctx.error(
            "agent.mcp_selector_duplicate",
            path,
            format!("Agent mcp server '{server_id}' behind must not contain duplicates"),
            Some("remove duplicate tool names"),
        );
    }
    for name in names.iter().filter(|name| name.contains('*')) {
        ctx.error(
            "agent.mcp_selector_invalid",
            path,
            format!(
                "Agent mcp server '{server_id}' behind entry '{name}' must be an exact tool name"
            ),
            None::<String>,
        );
    }
    for key in ["defer", "eager"]
        .into_iter()
        .filter(|key| server.contains_key(*key))
    {
        ctx.error(
            "agent.mcp_behind_activation",
            path,
            format!("Agent mcp server '{server_id}' may not use {key} with behind"),
            Some("a server behind a tool is never declared to the model; remove defer and eager"),
        );
    }
    Some(names.into_iter().map(str::to_owned).collect())
}

fn validate_agent_system_instructions(map: &JsonMap, path: &str, ctx: &mut CheckContext) {
    let Some(value) = map.get("system_instructions") else {
        return;
    };
    let Some(system) = value.as_object() else {
        ctx.error(
            "agent.system_instructions_invalid",
            path,
            "Agent system_instructions must be an object",
            None::<String>,
        );
        return;
    };
    for key in system
        .keys()
        .filter(|key| !matches!(key.as_str(), "mode" | "content"))
    {
        ctx.error(
            "agent.system_instructions_key_unknown",
            path,
            format!("Agent system_instructions contains unknown field '{key}'"),
            Some("use only mode and content"),
        );
    }
    match system.get("content") {
        Some(JsonValue::String(_)) => {}
        Some(_) => ctx.error(
            "agent.system_instructions_invalid",
            path,
            "Agent system_instructions.content must be a string",
            None::<String>,
        ),
        None => ctx.error(
            "agent.system_instructions_invalid",
            path,
            "Agent system_instructions must declare content",
            None::<String>,
        ),
    }
    if let Some(mode) = system.get("mode") {
        match mode {
            JsonValue::String(value) if value == "append" || value == "replace" => {}
            JsonValue::String(_) => ctx.error(
                "agent.system_instructions_invalid",
                path,
                "Agent system_instructions.mode must be append or replace",
                None::<String>,
            ),
            _ => ctx.error(
                "agent.system_instructions_invalid",
                path,
                "Agent system_instructions.mode must be a string",
                None::<String>,
            ),
        }
    }
}

fn validate_agent_names(sources: &[RawAgent], ctx: &mut CheckContext) {
    let mut name_counts: HashMap<&str, usize> = HashMap::new();
    for source in sources {
        *name_counts.entry(source.name.as_str()).or_default() += 1;
    }
    for (name, count) in name_counts {
        if count > 1 {
            ctx.error(
                "agent.name_duplicate",
                "agents",
                format!("Recipe agent name '{name}' is declared by multiple files"),
                Some("choose unique agent names"),
            );
        }
    }
}

fn validate_agent_inheritance(
    name: &str,
    raw_by_name: &HashMap<String, &RawAgent>,
    ctx: &mut CheckContext,
) {
    let mut stack = Vec::new();
    let mut current = name.to_owned();
    loop {
        if stack.len() >= MAX_INHERITANCE_DEPTH {
            let path = raw_by_name
                .get(&current)
                .map(|agent| agent.path.clone())
                .unwrap_or_else(|| "agents".to_owned());
            ctx.error(
                "agent.from_depth",
                path,
                format!(
                    "Recipe agent '{name}' exceeds the maximum from depth of {MAX_INHERITANCE_DEPTH}"
                ),
                Some("flatten the inheritance chain"),
            );
            return;
        }
        let Some(agent) = raw_by_name.get(&current) else {
            return;
        };
        let Some(from) = &agent.from else {
            return;
        };
        let parent = from.to_owned();
        if stack.contains(&parent) || parent == current {
            ctx.error(
                "agent.from_cycle",
                agent.path.clone(),
                format!("Recipe agent '{}' has cyclic from chain", agent.name),
                Some("remove the inheritance cycle"),
            );
            return;
        }
        if !raw_by_name.contains_key(&parent) {
            ctx.error(
                "agent.from_missing",
                agent.path.clone(),
                format!(
                    "Recipe agent '{}' inherits from missing agent '{}'",
                    agent.name, from
                ),
                Some("update from to reference an existing agent"),
            );
            return;
        }
        stack.push(current);
        current = parent;
    }
}

fn resolved_field_provided(
    name: &str,
    field: AgentField,
    raw_by_name: &HashMap<String, &RawAgent>,
    stack: &mut Vec<String>,
) -> bool {
    if stack.iter().any(|item| item == name) || stack.len() >= MAX_INHERITANCE_DEPTH {
        return false;
    }
    let Some(agent) = raw_by_name.get(name) else {
        return false;
    };
    if agent.fields.contains(&field) {
        return true;
    }
    if let Some(parent) = &agent.from {
        stack.push(name.to_owned());
        return resolved_field_provided(parent, field, raw_by_name, stack);
    }
    false
}

fn packaged_skill_names(
    resource_paths: &[String],
    package_roots: &[String],
    ctx: &CheckContext,
) -> BTreeMap<String, Vec<String>> {
    let mut skill_files = BTreeSet::new();
    for resource in resource_paths {
        if ctx.has_file(resource) {
            if resource.ends_with("/SKILL.md") || resource == "SKILL.md" {
                skill_files.insert(resource.clone());
            }
            continue;
        }
        discover_skill_files(resource, ctx, &mut skill_files);
    }
    let mut names = BTreeMap::<String, Vec<String>>::new();
    for path in skill_files {
        let name = skill_frontmatter_name(&path, ctx).unwrap_or_else(|| {
            let parent = Path::new(&path)
                .parent()
                .and_then(Path::to_str)
                .unwrap_or("");
            if parent.is_empty() || package_roots.iter().any(|root| root == parent) {
                return "skill".to_owned();
            }
            Path::new(parent)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("skill")
                .to_owned()
        });
        names.entry(name).or_default().push(path);
    }
    names
}

fn discover_skill_files(resource: &str, ctx: &CheckContext, skill_files: &mut BTreeSet<String>) {
    if !ctx.has_dir(resource) {
        return;
    }
    let direct = format!("{}/SKILL.md", resource.trim_end_matches('/'));
    if ctx.has_file(&direct) {
        skill_files.insert(direct);
        return;
    }
    let prefix = format!("{}/", resource.trim_end_matches('/'));
    let children = ctx
        .directories
        .iter()
        .filter(|path| path.starts_with(&prefix) && !path[prefix.len()..].contains('/'))
        .cloned()
        .collect::<Vec<_>>();
    for child in children {
        discover_skill_files(&child, ctx, skill_files);
    }
}

fn skill_frontmatter_name(path: &str, ctx: &CheckContext) -> Option<String> {
    let content = ctx.content(path)?;
    let normalized = content.replace("\r\n", "\n");
    let rest = normalized.strip_prefix("---\n")?;
    let end = rest
        .find("\n---\n")
        .or_else(|| rest.strip_suffix("\n---").map(str::len))?;
    let frontmatter = &rest[..end];
    let parsed: JsonValue = serde_saphyr::from_str(frontmatter).ok()?;
    obj_string(parsed.as_object()?, "name")
}

fn validate_declared_agent_references(
    agent: &RawAgent,
    raw_by_name: &HashMap<String, &RawAgent>,
    skill_names: &BTreeMap<String, Vec<String>>,
    uninstalled_dependencies: &[String],
    ctx: &mut CheckContext,
) {
    let name = &agent.name;
    let path = &agent.path;
    for skill in agent.skills.as_deref().unwrap_or_default() {
        let matches = skill_names
            .get(skill)
            .map(Vec::as_slice)
            .unwrap_or_default();
        match matches.len() {
            // A dependency missing from the snapshot may ship the skill, and a
            // check without node_modules (CI) must not fail on that.
            0 if !uninstalled_dependencies.is_empty() => ctx.warning(
                "agent.skill_unverified",
                path,
                format!(
                    "Recipe agent '{name}' skill '{skill}' is not in the Recipe and was not checked against dependencies that are not installed: {}",
                    uninstalled_dependencies.join(", ")
                ),
                Some("install dependencies before checking to verify skills from dependency packages"),
            ),
            0 => ctx.error(
                "agent.skill_missing",
                path,
                format!("Recipe agent '{name}' references missing packaged skill '{skill}'"),
                Some("declare the skill under package.json#pi.skills, or in a dependency's pi.skills, or remove the reference"),
            ),
            1 => {}
            count => ctx.error(
                "agent.skill_ambiguous",
                path,
                format!(
                    "Recipe agent '{name}' skill '{skill}' resolves to {count} packaged SKILL.md files: {}",
                    matches.join(", ")
                ),
                Some("give packaged skills unique frontmatter names, across the Recipe and its dependencies"),
            ),
        }
    }
    for subagent in agent.subagents.as_deref().unwrap_or_default() {
        if !raw_by_name.contains_key(subagent) {
            ctx.error(
                "agent.subagent_missing",
                path,
                format!("Recipe agent '{name}' references missing subagent '{subagent}'"),
                Some("add the agent definition or remove the reference"),
            );
        }
    }
}

fn resolved_agent_mcp(
    name: &str,
    raw_by_name: &HashMap<String, &RawAgent>,
    stack: &mut Vec<String>,
) -> Option<AgentMcpConfig> {
    if stack.iter().any(|item| item == name) || stack.len() >= MAX_INHERITANCE_DEPTH {
        return None;
    }
    let agent = raw_by_name.get(name)?;
    stack.push(name.to_owned());
    let inherited = agent
        .from
        .as_deref()
        .and_then(|parent| resolved_agent_mcp(parent, raw_by_name, stack))
        .unwrap_or_default();
    stack.pop();

    let Some(child) = &agent.mcp else {
        return (!inherited.servers.is_empty() || inherited.mode.is_some()).then_some(inherited);
    };
    let mut merged = child.clone();
    if merged.mode.is_some() {
        for selection in merged.servers.values_mut() {
            if !activation_allowed("defer", merged.mode) {
                selection.defer = None;
            }
            if !activation_allowed("eager", merged.mode) {
                selection.eager = None;
            }
        }
    }
    Some(merged)
}

/// `defer` hides a declared tool behind tool search, so it needs `tools`; `eager` declares a tool
/// directly, which `tools` and `codemode` both do. A resolved mode is never absent: it defaults to cli.
fn activation_allowed(key: &str, mode: Option<AgentMcpMode>) -> bool {
    match key {
        "defer" => mode == Some(AgentMcpMode::Tools),
        _ => matches!(mode, Some(AgentMcpMode::Tools | AgentMcpMode::Codemode)),
    }
}

fn mode_name(mode: Option<AgentMcpMode>) -> &'static str {
    match mode {
        Some(AgentMcpMode::Tools) => "tools",
        Some(AgentMcpMode::Codemode) => "codemode",
        Some(AgentMcpMode::Cli) | None => "cli",
    }
}

fn activation_help(key: &str) -> &'static str {
    if key == "defer" {
        "defer needs mcp.mode tools; in codemode every tool is already off the model's declarations"
    } else {
        "eager needs mcp.mode tools or codemode"
    }
}

fn portable_agent_name(value: &str) -> bool {
    let mut parts = value.split('-');
    let valid_part = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    };
    parts.all(valid_part)
}

fn resolved_agent_tools(name: &str, raw_by_name: &HashMap<String, &RawAgent>) -> Vec<String> {
    let mut current = raw_by_name.get(name);
    for _ in 0..MAX_INHERITANCE_DEPTH {
        let Some(agent) = current else {
            break;
        };
        if let Some(tools) = &agent.tools {
            return tools.clone();
        }
        current = agent
            .from
            .as_deref()
            .and_then(|parent| raw_by_name.get(parent));
    }
    Vec::new()
}

fn validate_resolved_agent_mcp(
    name: &str,
    raw_by_name: &HashMap<String, &RawAgent>,
    mcp_tool_policy: Option<&McpToolPolicy>,
    ctx: &mut CheckContext,
) {
    let Some(mcp) = resolved_agent_mcp(name, raw_by_name, &mut Vec::new()) else {
        return;
    };
    let path = raw_by_name
        .get(name)
        .map(|agent| agent.path.clone())
        .unwrap_or_default();

    let tools = resolved_agent_tools(name, raw_by_name);
    for (server_id, selection) in &mcp.servers {
        for tool in selection
            .behind
            .iter()
            .flatten()
            .filter(|tool| !tools.contains(tool))
        {
            ctx.error(
                "agent.mcp_behind_tool_undeclared",
                path.clone(),
                format!(
                    "Recipe agent '{name}' puts MCP server '{server_id}' behind tool '{tool}', which it does not declare"
                ),
                Some("add the tool to the agent's tools, or name a tool it declares"),
            );
        }
    }

    for (key, used) in [
        (
            "defer",
            mcp.servers
                .values()
                .any(|selection| selection.defer.is_some()),
        ),
        (
            "eager",
            mcp.servers
                .values()
                .any(|selection| selection.eager.is_some()),
        ),
    ] {
        if used && !activation_allowed(key, mcp.mode) {
            ctx.error(
                "agent.mcp_activation_invalid",
                path.clone(),
                format!(
                    "Recipe agent '{name}' may not use {key} when its resolved mcp.mode is {}",
                    mode_name(mcp.mode)
                ),
                Some(activation_help(key)),
            );
        }
    }

    for (server_id, selection) in &mcp.servers {
        let Some(server_policy) = mcp_tool_policy.and_then(|policy| policy.get(server_id)) else {
            ctx.error(
                "agent.mcp_server_undeclared",
                path.clone(),
                format!("Recipe agent '{name}' references undeclared MCP server '{server_id}'"),
                Some("add the server to package.json#pi.mcp.servers or remove it from the agent"),
            );
            continue;
        };
        let Some(include) = &selection.include else {
            continue;
        };
        for tool in include.iter().filter(|tool| tool.as_str() != "*") {
            if mcp_package_policy_allows(server_policy, tool) {
                continue;
            }
            ctx.error(
                "agent.mcp_tool_undeclared",
                path.clone(),
                format!(
                    "Recipe agent '{name}' MCP tool '{server_id}/{tool}' is not included by the package policy"
                ),
                Some("include the tool in the package MCP policy or update the agent"),
            );
        }
    }
    for (server_id, selection) in &mcp.servers {
        for (kind, selectors) in [
            ("defer", selection.defer.as_ref()),
            ("eager", selection.eager.as_ref()),
        ] {
            let Some(selectors) = selectors else {
                continue;
            };
            for tool in selectors.iter().filter(|tool| tool.as_str() != "*") {
                if mcp_package_policy_allows(selection, tool) {
                    continue;
                }
                ctx.error(
                    "agent.mcp_activation_tool_unauthorized",
                    path.clone(),
                    format!(
                        "Recipe agent '{name}' {kind} selector '{server_id}/{tool}' is outside its mcp.servers authorization"
                    ),
                    Some(format!(
                        "authorize the tool under mcp.servers or remove it from {kind}"
                    )),
                );
            }
        }
    }
}

fn validate_mcp_config(value: Option<&JsonValue>, ctx: &mut CheckContext) {
    let Some(value) = value else {
        return;
    };
    match value {
        JsonValue::Object(map) => {
            for key in map
                .keys()
                .filter(|key| !matches!(key.as_str(), "manifests" | "servers"))
            {
                ctx.error(
                    "pi.mcp_invalid",
                    PACKAGE_JSON,
                    format!("package.json#pi.mcp contains unknown field '{key}'"),
                    Some("use only manifests and servers"),
                );
            }
            if let Some(manifests) = map.get("manifests") {
                match manifests {
                    JsonValue::Array(items) => {
                        let mut seen = BTreeSet::new();
                        for (index, item) in items.iter().enumerate() {
                            if let Some(path) = string_value(Some(item)) {
                                if !seen.insert(path.clone()) {
                                    ctx.error(
                                        "pi.mcp_invalid",
                                        PACKAGE_JSON,
                                        format!(
                                            "package.json#pi.mcp.manifests contains duplicate entry '{path}'"
                                        ),
                                        Some("remove duplicate MCP manifest declarations"),
                                    );
                                    continue;
                                }
                                validate_mcp_manifest_pattern(&path, ctx);
                            } else {
                                ctx.error(
                                    "pi.mcp_invalid",
                                    PACKAGE_JSON,
                                    format!("package.json#pi.mcp.manifests[{index}] must be a non-empty string"),
                                    Some("remove the entry or provide a relative manifest path"),
                                );
                            }
                        }
                    }
                    _ => ctx.error(
                        "pi.mcp_invalid",
                        PACKAGE_JSON,
                        "package.json#pi.mcp.manifests must be an array of strings",
                        Some("use a list of relative manifest paths"),
                    ),
                }
            }
            validate_mcp_servers(map.get("servers"), ctx);
        }
        _ => ctx.error(
            "pi.mcp_invalid",
            PACKAGE_JSON,
            "package.json#pi.mcp must be an object",
            Some("remove mcp for no access, or use manifests and servers"),
        ),
    }
}

fn validate_mcp_servers(value: Option<&JsonValue>, ctx: &mut CheckContext) {
    let Some(value) = value else {
        return;
    };
    let JsonValue::Array(servers) = value else {
        ctx.error(
            "pi.mcp_invalid",
            PACKAGE_JSON,
            "package.json#pi.mcp.servers must be an array",
            Some("use a list of MCP server declarations"),
        );
        return;
    };
    let mut seen_ids = BTreeSet::new();
    let mut seen_normalized_ids = BTreeSet::new();
    for (index, server) in servers.iter().enumerate() {
        let JsonValue::Object(server) = server else {
            ctx.error(
                "pi.mcp_invalid",
                PACKAGE_JSON,
                format!("package.json#pi.mcp.servers[{index}] must be an object"),
                Some("remove the entry or make it a server declaration"),
            );
            continue;
        };
        for key in server
            .keys()
            .filter(|key| !matches!(key.as_str(), "id" | "required" | "discovery" | "tools"))
        {
            ctx.error(
                "pi.mcp_invalid",
                PACKAGE_JSON,
                format!("package.json#pi.mcp.servers[{index}] contains unknown field '{key}'"),
                Some("use only id, required, discovery, and tools"),
            );
        }
        let server_id = string_value(server.get("id"));
        if server_id.is_none() {
            ctx.error(
                "pi.mcp_invalid",
                PACKAGE_JSON,
                format!("package.json#pi.mcp.servers[{index}].id must be a non-empty string"),
                Some("give the server a non-empty identifier"),
            );
        } else if let Some(server_id) = server_id {
            let normalized = safe_mcp_server_id(&server_id);
            if !seen_ids.insert(server_id.clone()) {
                ctx.error(
                    "pi.mcp_invalid",
                    PACKAGE_JSON,
                    format!("package.json#pi.mcp contains duplicate server id '{server_id}'"),
                    Some("remove the duplicate server"),
                );
            }
            if !seen_normalized_ids.insert(normalized) {
                ctx.error(
                    "pi.mcp_invalid",
                    PACKAGE_JSON,
                    format!(
                        "package.json#pi.mcp server id '{server_id}' collides after normalization"
                    ),
                    Some("use server ids that remain unique after normalization"),
                );
            }
        }
        if let Some(required) = server.get("required") {
            if !required.is_boolean() {
                ctx.error(
                    "pi.mcp_invalid",
                    PACKAGE_JSON,
                    format!("package.json#pi.mcp.servers[{index}].required must be boolean"),
                    Some("remove required or set it to a boolean value"),
                );
            }
        }
        if let Some(discovery) = server.get("discovery") {
            if !matches!(discovery.as_str(), Some("require" | "defer")) {
                ctx.error(
                    "pi.mcp_invalid",
                    PACKAGE_JSON,
                    format!(
                        "package.json#pi.mcp.servers[{index}].discovery must be \"require\" or \"defer\""
                    ),
                    Some("remove discovery or set it to \"require\" or \"defer\""),
                );
            }
        }
        if let Some(tools) = server.get("tools") {
            let JsonValue::Object(tools) = tools else {
                ctx.error(
                    "pi.mcp_invalid",
                    PACKAGE_JSON,
                    format!("package.json#pi.mcp.servers[{index}].tools must be an object"),
                    Some("remove tools for no access, or declare a tool policy"),
                );
                continue;
            };
            for key in tools
                .keys()
                .filter(|key| !matches!(key.as_str(), "include" | "exclude"))
            {
                ctx.error(
                    "pi.mcp_invalid",
                    PACKAGE_JSON,
                    format!(
                        "package.json#pi.mcp.servers[{index}].tools contains unknown field '{key}'"
                    ),
                    Some("use only include and exclude"),
                );
            }
            for key in ["include", "exclude"] {
                let Some(selectors) = tools.get(key) else {
                    continue;
                };
                validate_json_string_array(
                    selectors,
                    &format!("package.json#pi.mcp.servers[{index}].tools.{key}"),
                    "pi.mcp_invalid",
                    ctx,
                );
                if let Some(selectors) = selectors.as_array() {
                    for selector in selectors
                        .iter()
                        .filter_map(JsonValue::as_str)
                        .map(str::trim)
                    {
                        let valid = if key == "include" {
                            !selector.is_empty() && (selector == "*" || !selector.contains('*'))
                        } else {
                            !selector.is_empty() && !selector.contains('*')
                        };
                        if !valid {
                            ctx.error(
                                "pi.mcp_selector_invalid",
                                PACKAGE_JSON,
                                format!(
                                    "package.json#pi.mcp.servers[{index}].tools.{key} entry '{selector}' must be {}",
                                    if key == "include" {
                                        "an exact tool name or '*'"
                                    } else {
                                        "an exact tool name"
                                    }
                                ),
                                None::<String>,
                            );
                        }
                    }
                }
            }
        }
    }
}

fn mcp_tool_policy(value: Option<&JsonValue>) -> Option<McpToolPolicy> {
    let JsonValue::Object(map) = value? else {
        return None;
    };
    let servers = map.get("servers")?;
    let JsonValue::Array(servers) = servers else {
        return None;
    };

    let mut policy: McpToolPolicy = BTreeMap::new();
    for server in servers {
        let JsonValue::Object(server) = server else {
            continue;
        };
        let Some(id) = string_value(server.get("id")) else {
            continue;
        };
        let tools = server.get("tools").and_then(JsonValue::as_object);
        let include = tools
            .and_then(|tools| tools.get("include"))
            .and_then(json_string_set);
        let exclude = tools.and_then(|tools| tools.get("exclude"));
        policy.insert(
            safe_mcp_server_id(&id),
            McpToolSelectors {
                include,
                exclude: exclude.and_then(json_string_set),
                defer: None,
                eager: None,
                behind: None,
            },
        );
    }
    Some(policy)
}

fn validate_mcp_manifest_pattern(pattern: &str, ctx: &mut CheckContext) {
    if let Err(message) = validate_relative_pattern(pattern) {
        ctx.error(
            "pi.mcp_manifest_invalid",
            PACKAGE_JSON,
            message,
            Some("use manifest paths relative to the recipe directory"),
        );
        return;
    }
    let matches = match_paths(ctx, pattern);
    if matches.is_empty() {
        ctx.error(
            "pi.mcp_manifest_missing",
            PACKAGE_JSON,
            format!("MCP manifest pattern '{pattern}' matched no files"),
            Some("add the manifest file or update package.json#pi.mcp"),
        );
    }
}

fn validate_json_string_array(value: &JsonValue, label: &str, code: &str, ctx: &mut CheckContext) {
    let JsonValue::Array(items) = value else {
        ctx.error(
            code,
            PACKAGE_JSON,
            format!("{label} must be an array of strings"),
            Some("use a list containing only non-empty strings"),
        );
        return;
    };
    let mut seen = BTreeSet::new();
    for (index, item) in items.iter().enumerate() {
        if string_value(Some(item)).is_none() {
            ctx.error(
                code,
                PACKAGE_JSON,
                format!("{label}[{index}] must be a non-empty string"),
                Some("remove the entry or replace it with a non-empty string"),
            );
        } else if let Some(value) = string_value(Some(item)) {
            if !seen.insert(value.clone()) {
                ctx.error(
                    code,
                    PACKAGE_JSON,
                    format!("{label} contains duplicate entry '{value}'"),
                    Some("remove duplicate entries"),
                );
            }
        }
    }
}

fn match_paths(ctx: &CheckContext, pattern: &str) -> Vec<String> {
    let normalized = normalize_slashes(pattern.trim().trim_start_matches("./"));
    if !has_glob(&normalized) {
        return ctx
            .path_exists(&normalized)
            .then_some(normalized)
            .into_iter()
            .collect();
    }

    let mut matches = BTreeSet::new();
    for path in ctx
        .files
        .keys()
        .map(String::as_str)
        .chain(ctx.directories.iter().map(String::as_str))
    {
        if glob_matches(&normalized, path) {
            matches.insert(path.to_owned());
        }
    }
    matches.into_iter().collect()
}

fn glob_matches(pattern: &str, path: &str) -> bool {
    let pattern = normalize_slashes(pattern);
    let path = normalize_slashes(path);
    glob_match_parts(
        &pattern.split('/').collect::<Vec<_>>(),
        &path.split('/').collect::<Vec<_>>(),
    )
}

fn glob_match_parts(pattern: &[&str], path: &[&str]) -> bool {
    if pattern.is_empty() {
        return path.is_empty();
    }
    if pattern[0] == "**" {
        return glob_match_parts(&pattern[1..], path)
            || (!path.is_empty() && glob_match_parts(pattern, &path[1..]));
    }
    if path.is_empty() {
        return false;
    }
    segment_match(pattern[0], path[0]) && glob_match_parts(&pattern[1..], &path[1..])
}

fn segment_match(pattern: &str, text: &str) -> bool {
    let pattern = pattern.as_bytes();
    let text = text.as_bytes();
    let (mut pi, mut ti) = (0, 0);
    let mut star = None;
    let mut match_i = 0;
    while ti < text.len() {
        if pi < pattern.len() && (pattern[pi] == b'?' || pattern[pi] == text[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < pattern.len() && pattern[pi] == b'*' {
            star = Some(pi);
            match_i = ti;
            pi += 1;
        } else if let Some(star_i) = star {
            pi = star_i + 1;
            match_i += 1;
            ti = match_i;
        } else {
            return false;
        }
    }
    while pi < pattern.len() && pattern[pi] == b'*' {
        pi += 1;
    }
    pi == pattern.len()
}

fn validate_relative_pattern(pattern: &str) -> Result<(), String> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return Err("resource pattern must be non-empty".to_owned());
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err(format!("resource pattern '{pattern}' must be relative"));
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) || trimmed
        .split(['/', '\\'])
        .any(|segment| segment == ".." || segment.is_empty())
    {
        return Err(format!(
            "resource pattern '{pattern}' escapes the recipe directory"
        ));
    }
    Ok(())
}

/// The strings in `value` when it is an array of unique non-empty strings.
fn unique_names(value: &JsonValue) -> Option<BTreeSet<&str>> {
    let mut seen = BTreeSet::new();
    value
        .as_array()?
        .iter()
        .all(|value| {
            value
                .as_str()
                .is_some_and(|value| !value.trim().is_empty() && seen.insert(value))
        })
        .then_some(seen)
}

fn string_value(value: Option<&JsonValue>) -> Option<String> {
    match value {
        Some(JsonValue::String(value)) if !value.trim().is_empty() => Some(value.trim().to_owned()),
        _ => None,
    }
}

fn has_dependency_lockfile(ctx: &CheckContext) -> bool {
    ctx.path_exists(PNPM_LOCKFILE)
}

fn has_non_empty_object(value: Option<&JsonValue>) -> bool {
    matches!(value, Some(JsonValue::Object(map)) if !map.is_empty())
}

fn obj_string(map: &JsonMap, key: &str) -> Option<String> {
    match map.get(key) {
        Some(JsonValue::String(value)) if !value.trim().is_empty() => Some(value.trim().to_owned()),
        _ => None,
    }
}

fn string_array(value: &JsonValue) -> Result<(), String> {
    let Some(items) = value.as_array() else {
        return Err("field must be an array of strings".to_owned());
    };
    for (index, item) in items.iter().enumerate() {
        if !matches!(item, JsonValue::String(value) if !value.trim().is_empty()) {
            return Err(format!("item {index} must be a non-empty string"));
        }
    }
    Ok(())
}

fn valid_model_spec(value: &str) -> bool {
    let Some((provider, model)) = value.split_once('/') else {
        return false;
    };
    !provider.is_empty()
        && !model.is_empty()
        && !provider.chars().any(|ch| ch.is_whitespace() || ch == ':')
}

fn json_string_set(value: &JsonValue) -> Option<BTreeSet<String>> {
    let items = value.as_array()?;
    Some(
        items
            .iter()
            .filter_map(|item| string_value(Some(item)))
            .collect(),
    )
}

fn mcp_package_policy_allows(policy: &McpToolSelectors, tool: &str) -> bool {
    let included = match &policy.include {
        Some(include) => include.contains("*") || include.contains(tool),
        None => false,
    };
    included
        && !policy
            .exclude
            .as_ref()
            .is_some_and(|exclude| exclude.contains(tool))
}

fn safe_mcp_server_id(value: &str) -> String {
    let mut id = String::new();
    let mut previous_dash = false;
    for ch in value.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            id.push(ch);
            previous_dash = false;
        } else if !previous_dash {
            id.push('-');
            previous_dash = true;
        }
    }
    let id = id.trim_matches('-').to_owned();
    if id.is_empty() {
        "mcp".to_owned()
    } else {
        id
    }
}

fn has_glob(value: &str) -> bool {
    value.chars().any(|ch| matches!(ch, '*' | '?'))
}

fn is_yaml_path(path: &str) -> bool {
    matches!(extension(path), Some("yaml" | "yml"))
}

fn is_loadable_extension_file(ctx: &CheckContext, path: &str) -> bool {
    ctx.has_file(path)
        && matches!(
            extension(path),
            Some("ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs")
        )
}

fn resolve_extension_entry(ctx: &CheckContext, path: &str) -> Vec<String> {
    if is_loadable_extension_file(ctx, path) {
        return vec![path.to_owned()];
    }
    if !ctx.has_dir(path) {
        return Vec::new();
    }

    if let Some(index) = extension_index(ctx, path) {
        return vec![index];
    }

    let prefix = format!("{path}/");
    let mut entries = BTreeSet::new();
    for file in ctx.files.keys() {
        let Some(relative) = file.strip_prefix(&prefix) else {
            continue;
        };
        if !relative.contains('/') && is_loadable_extension_file(ctx, file) {
            entries.insert(file.clone());
            continue;
        }
        let Some((child, remainder)) = relative.split_once('/') else {
            continue;
        };
        if !remainder.contains('/')
            && remainder.starts_with("index.")
            && is_loadable_extension_file(ctx, file)
            && extension_index(ctx, &format!("{path}/{child}")).as_deref() == Some(file.as_str())
        {
            entries.insert(file.clone());
        }
    }
    entries.into_iter().collect()
}

fn extension_index(ctx: &CheckContext, directory: &str) -> Option<String> {
    ["ts", "tsx", "js", "jsx", "mjs", "cjs"]
        .into_iter()
        .map(|extension| format!("{directory}/index.{extension}"))
        .find(|path| ctx.has_file(path))
}

fn extension(path: &str) -> Option<&str> {
    let name = path.rsplit('/').next()?;
    let (stem, extension) = name.rsplit_once('.')?;
    (!stem.is_empty()).then_some(extension)
}

fn normalize_slashes(value: &str) -> String {
    value.replace('\\', "/")
}

fn normalize_relative(path: &str) -> String {
    let mut normalized = normalize_slashes(path.trim());
    while let Some(stripped) = normalized.strip_prefix("./") {
        normalized = stripped.to_owned();
    }
    normalized.trim_matches('/').to_owned()
}

fn ancestor_dirs(path: &str) -> Vec<String> {
    let mut ancestors = Vec::new();
    for (index, ch) in path.char_indices() {
        if ch == '/' {
            ancestors.push(path[..index].to_owned());
        }
    }
    ancestors
}

/// Best-effort extraction of "line N column M" from a parser error message.
fn span_from_message(message: &str) -> Option<Span> {
    fn number_after<'a>(message: &'a str, keyword: &str) -> Option<(usize, &'a str)> {
        let start = message.find(keyword)? + keyword.len();
        let rest = message[start..].trim_start();
        let digits_len = rest.chars().take_while(char::is_ascii_digit).count();
        if digits_len == 0 {
            return None;
        }
        let value = rest[..digits_len].parse().ok()?;
        Some((value, &rest[digits_len..]))
    }

    let (line, rest) = number_after(message, "line")?;
    let column = number_after(rest, "column").map(|(value, _)| value)?;
    Some(Span { line, column })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Deserialize)]
    struct ConformanceFixture {
        name: String,
        valid: bool,
        files: BTreeMap<String, String>,
    }

    #[test]
    fn shared_format_conformance_fixtures() {
        let fixtures: Vec<ConformanceFixture> = serde_json::from_str(include_str!(
            "../../../test/fixtures/format-conformance.json"
        ))
        .expect("shared conformance fixtures must parse");
        for fixture in fixtures {
            let input = RecipeFiles {
                files: fixture
                    .files
                    .into_iter()
                    .map(|(path, content)| RecipeFile::new(path, content))
                    .collect(),
                directories: Vec::new(),
            };
            let report = check_recipe_files(&input);
            assert_eq!(
                report.valid, fixture.valid,
                "{}: {:?}",
                fixture.name, report.diagnostics
            );
        }
    }

    fn recipe_files(files: &[(&str, &str)]) -> RecipeFiles {
        RecipeFiles {
            files: files
                .iter()
                .map(|(path, content)| RecipeFile::new(*path, *content))
                .collect(),
            directories: Vec::new(),
        }
    }

    fn selector_recipe(
        package_tools: JsonValue,
        agent_mcp: &str,
        include_bash: bool,
    ) -> RecipeFiles {
        let package = json!({
            "name": "mcp-selector-test",
            "version": "0.1.0",
            "pi": {
                "agents": ["agents/*.yaml"],
                "mcp": {
                    "servers": [{
                        "id": "salesforce",
                        "tools": package_tools
                    }]
                }
            }
        });
        let bash = if include_bash { "  - bash\n" } else { "" };
        let agent = format!(
            concat!(
                "name: agent\n",
                "description: Test agent\n",
                "model:\n",
                "  name: test/provider-model\n",
                "  thinking_level: low\n",
                "tools:\n",
                "  - read\n",
                "{}",
                "mcp:\n",
                "{}",
                "skills: []\n",
                "subagents: []\n",
                "system_instructions:\n",
                "  mode: append\n",
                "  content: Test instructions\n",
            ),
            bash, agent_mcp
        );
        recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("agents/agent.yaml", &agent),
        ])
    }

    fn connector_recipe(agent_tools: &[&str]) -> RecipeFiles {
        let package = json!({
            "name": "connector-test",
            "version": "0.1.0",
            "dependencies": {
                "@introspection-ai/recipe-channel-slack": "0.1.0"
            },
            "pi": {
                "agents": ["agents/*.yaml"],
                "channels": [{
                    "provider": "slack"
                }]
            }
        });
        let tools = agent_tools
            .iter()
            .map(|tool| format!("  - {tool}\n"))
            .collect::<String>();
        let agent = format!(
            concat!(
                "name: agent\n",
                "model:\n",
                "  name: test/provider-model\n",
                "tools:\n",
                "{}",
            ),
            tools
        );
        recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("pnpm-lock.yaml", "lockfileVersion: '9.0'\n"),
            ("agents/agent.yaml", &agent),
        ])
    }

    fn documents_recipe(documents: JsonValue, dependencies: JsonValue) -> RecipeFiles {
        let package = json!({
            "name": "documents-test",
            "version": "0.1.0",
            "dependencies": dependencies,
            "pi": { "agents": ["agents/*.yaml"], "documents": documents }
        });
        recipe_files(&[
            (
                "package.json",
                &serde_json::to_string(&package).expect("serialize package"),
            ),
            ("pnpm-lock.yaml", "lockfileVersion: '9.0'\n"),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\ntools: [documents]\n",
            ),
        ])
    }

    fn documents_dependencies() -> JsonValue {
        json!({
            "@introspection-ai/recipe-documents-docx": "0.1.0",
            "@introspection-ai/recipe-documents-pdf": "0.1.0"
        })
    }

    fn documents_invalid(report: &Report) -> bool {
        report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "pi.documents_invalid")
    }

    #[test]
    fn accepts_document_format_declarations() {
        let report = check_recipe_files(&documents_recipe(
            json!([
                { "format": "docx", "commands": ["read", "propose_edits"], "profile": "legal-redlining-en-US" },
                { "format": "pdf", "profile": "./profiles/brief-reading-en-us" }
            ]),
            documents_dependencies(),
        ));
        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn companion_document_format_may_be_omitted_or_a_peer() {
        let omitted = check_recipe_files(&documents_recipe(
            json!([{ "format": "docx" }, { "format": "pdf" }]),
            json!({}),
        ));
        assert!(omitted.valid, "{:?}", omitted.diagnostics);

        let peer = |version: JsonValue| {
            let mut files = documents_recipe(json!([{ "format": "docx" }]), json!({}));
            let package_file = files
                .files
                .iter_mut()
                .find(|file| file.path == PACKAGE_JSON)
                .expect("package.json");
            let mut package: JsonValue =
                serde_json::from_str(package_file.content.as_deref().expect("package content"))
                    .expect("parse package");
            package["peerDependencies"] =
                json!({ "@introspection-ai/recipe-documents-docx": version });
            package_file.content = Some(serde_json::to_string(&package).expect("serialize"));
            check_recipe_files(&files)
        };
        let provided = peer(json!(">=0.3.0"));
        assert!(
            provided.valid && provided.diagnostics.is_empty(),
            "{:?}",
            provided.diagnostics
        );
        let versionless = peer(json!(""));
        assert_eq!(
            codes(&versionless),
            [("package.peer_version_missing", Severity::Error)]
        );

        let listed_without_version = check_recipe_files(&documents_recipe(
            json!([{ "format": "docx" }]),
            json!({ "@introspection-ai/recipe-documents-docx": "" }),
        ));
        assert!(documents_invalid(&listed_without_version));
    }

    #[test]
    fn document_format_without_a_companion_requires_its_package() {
        let report = check_recipe_files(&documents_recipe(json!([{ "format": "odt" }]), json!({})));
        assert!(
            report.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == "pi.documents_invalid"
                    && diagnostic.message.contains("recipe-documents-odt")
            }),
            "{:?}",
            report.diagnostics
        );
    }

    /// The checker's companion packages are the `@introspection-ai/recipe-*`
    /// keys of `optionalDependencies` in the Recipes package.json. A release
    /// also stamps the MCP client's platform binaries there; they aren't
    /// companions.
    #[test]
    fn companion_packages_match_the_recipes_package() {
        let manifest: JsonValue = serde_json::from_str(include_str!("../../../package.json"))
            .expect("Recipes package.json must parse");
        let declared: BTreeSet<&str> = manifest["optionalDependencies"]
            .as_object()
            .expect("optionalDependencies must be an object")
            .keys()
            .map(String::as_str)
            .filter(|name| name.starts_with("@introspection-ai/recipe-"))
            .collect();
        assert_eq!(
            declared,
            COMPANION_PACKAGES.into_iter().collect::<BTreeSet<_>>()
        );
    }

    #[test]
    fn document_declaration_shape() {
        for (documents, valid) in [
            (json!([{ "format": "docx" }]), true),
            (json!([{ "format": "docx", "commands": [] }]), true),
            (json!({ "format": "docx" }), false),
            (json!(["word"]), false),
            (json!([{ "format": "" }]), false),
            (json!([{ "format": "docx" }, { "format": "docx" }]), false),
            (json!([{ "format": "docx", "provider": "word" }]), false),
            (
                json!([{ "format": "docx", "commands": ["read", "read"] }]),
                false,
            ),
            (json!([{ "format": "docx", "commands": "read" }]), false),
            (
                json!([{ "format": "docx", "commands": ["redline"] }]),
                false,
            ),
            (
                json!([{ "format": "docx", "profile": "legal-redlining-en-US" }]),
                true,
            ),
            (
                json!([{ "format": "docx", "profile": "./profiles/house-style-en-gb" }]),
                true,
            ),
            (
                json!([{ "format": "docx", "profile": "profiles/house-style-en-gb/SKILL.md" }]),
                true,
            ),
            (
                json!([{ "format": "docx", "profile": "legal-redlining" }]),
                true,
            ),
            (
                json!([{ "format": "docx", "profile": "../profile.ts" }]),
                false,
            ),
            (
                json!([{ "format": "docx", "profile": "/abs/profile.ts" }]),
                false,
            ),
            (
                json!([{ "format": "docx", "profile": "C:\\profiles\\house" }]),
                false,
            ),
            (
                json!([{ "format": "docx", "profile": "profiles/../../outside" }]),
                false,
            ),
            (json!([{ "format": "docx", "profile": "" }]), false),
            (json!([{ "format": "docx", "profile": 3 }]), false),
        ] {
            let report = check_recipe_files(&documents_recipe(
                documents.clone(),
                documents_dependencies(),
            ));
            assert_eq!(
                !documents_invalid(&report),
                valid,
                "{documents}: {:?}",
                report.diagnostics
            );
        }
    }

    fn productivity_recipe(productivity: JsonValue, dependencies: JsonValue) -> RecipeFiles {
        let package = json!({
            "name": "productivity-test",
            "version": "0.1.0",
            "dependencies": dependencies,
            "pi": { "agents": ["agents/*.yaml"], "productivity": productivity }
        });
        recipe_files(&[
            (
                "package.json",
                &serde_json::to_string(&package).expect("serialize package"),
            ),
            ("pnpm-lock.yaml", "lockfileVersion: '9.0'\n"),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\ntools: [mail, calendar]\n",
            ),
        ])
    }

    fn productivity_invalid(report: &Report) -> bool {
        report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "pi.productivity_invalid")
    }

    #[test]
    fn productivity_declaration_shape() {
        let pinned = json!({ "@introspection-ai/recipe-productivity-acme": "0.1.0" });
        for (productivity, valid) in [
            (json!([{ "provider": "acme" }]), true),
            (
                json!([{ "provider": "acme", "tools": { "mail": ["search", "read", "draft"], "calendar": [], "drive": ["search"] } }]),
                true,
            ),
            (json!({ "provider": "acme" }), false),
            (json!(["acme"]), false),
            (json!([{ "provider": "" }]), false),
            (
                json!([{ "provider": "acme" }, { "provider": "acme" }]),
                false,
            ),
            (json!([{ "provider": "acme", "commands": ["read"] }]), false),
            (json!([{ "provider": "acme", "tools": ["mail"] }]), false),
            (
                json!([{ "provider": "acme", "tools": { "chat": ["read"] } }]),
                false,
            ),
            (
                json!([{ "provider": "acme", "tools": { "mail": "send" } }]),
                false,
            ),
            (
                json!([{ "provider": "acme", "tools": { "mail": ["send", "send"] } }]),
                false,
            ),
            (
                json!([{ "provider": "acme", "tools": { "mail": ["forward"] } }]),
                false,
            ),
            (
                json!([{ "provider": "acme", "tools": { "drive": ["share"] } }]),
                false,
            ),
        ] {
            let report =
                check_recipe_files(&productivity_recipe(productivity.clone(), pinned.clone()));
            assert_eq!(
                !productivity_invalid(&report),
                valid,
                "{productivity}: {:?}",
                report.diagnostics
            );
        }
    }

    #[test]
    fn productivity_refuses_a_second_provider() {
        let report = check_recipe_files(&productivity_recipe(
            json!([{ "provider": "acme" }, { "provider": "other" }]),
            json!({
                "@introspection-ai/recipe-productivity-acme": "0.1.0",
                "@introspection-ai/recipe-productivity-other": "0.1.0"
            }),
        ));
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "pi.productivity_invalid"
                && diagnostic.message.contains("more than one provider")
        }));
    }

    #[test]
    fn productivity_provider_without_a_companion_requires_its_package() {
        let report = check_recipe_files(&productivity_recipe(
            json!([{ "provider": "acme" }]),
            json!({}),
        ));
        assert!(
            report.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == "pi.productivity_invalid"
                    && diagnostic.message.contains("recipe-productivity-acme")
            }),
            "{:?}",
            report.diagnostics
        );
    }

    /// A Recipe whose `pi` carries `key: value`, with an optional provider file.
    fn provider_recipe(key: &str, value: JsonValue, dependencies: JsonValue) -> RecipeFiles {
        let package = json!({
            "name": "provider-test",
            "version": "0.1.0",
            "dependencies": dependencies,
            "pi": { "agents": ["agents/*.yaml"], key: value }
        });
        let package = serde_json::to_string(&package).expect("serialize package");
        recipe_files(&[
            ("package.json", package.as_str()),
            ("pnpm-lock.yaml", "lockfileVersion: '9.0'\n"),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\n",
            ),
        ])
    }

    fn invalid_with(report: &Report, code: &str, text: &str) -> bool {
        report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == code && diagnostic.message.contains(text))
    }

    #[test]
    fn search_declarations_take_first_party_ids_or_a_source() {
        let ok = check_recipe_files(&provider_recipe(
            "search",
            json!([
                { "provider": "brave" },
                { "provider": "beta", "package": "@acme/search" }
            ]),
            json!({ "@acme/search": "1.0.0" }),
        ));
        assert!(
            !ok.diagnostics
                .iter()
                .any(|d| d.code == "pi.search_invalid" || d.code == "pi.unknown_key"),
            "{:?}",
            ok.diagnostics
        );
        for (declarations, text) in [
            (json!([{ "provider": "acme" }]), "not first-party"),
            (
                json!([{ "provider": "brave" }, { "provider": "brave" }]),
                "more than once",
            ),
            (
                json!([{ "provider": "acme", "package": "@acme/search" }]),
                "@acme/search",
            ),
            (
                json!([{ "provider": "acme", "module": "./x.ts" }]),
                "unknown field 'module'",
            ),
            (
                json!([{ "provider": "brave", "extra": true }]),
                "unknown field",
            ),
        ] {
            let report = check_recipe_files(&provider_recipe("search", declarations, json!({})));
            assert!(
                invalid_with(&report, "pi.search_invalid", text),
                "{text}: {:?}",
                report.diagnostics
            );
        }
    }

    #[test]
    fn issues_declarations_take_first_party_ids_with_their_options() {
        let ok = check_recipe_files(&provider_recipe(
            "issues",
            json!([
                { "provider": "linear", "options": { "team": "ENG", "server": "linear-mcp" } },
                { "provider": "jira", "options": { "project": "OPS", "issueType": "Task" } },
                { "provider": "introspection", "enabled": false },
                { "provider": "acme", "package": "@acme/issues", "options": { "queue": "ops", "urgent": true } }
            ]),
            json!({ "@acme/issues": "1.0.0" }),
        ));
        assert!(
            !ok.diagnostics
                .iter()
                .any(|d| d.code == "pi.issues_invalid" || d.code == "pi.unknown_key"),
            "{:?}",
            ok.diagnostics
        );
        for (declarations, text) in [
            (json!([{ "provider": "acme" }]), "not first-party"),
            (
                json!([{ "provider": "linear", "team": "ENG" }]),
                "unknown field 'team'",
            ),
            (
                json!([{ "provider": "linear", "options": { "project": "OPS" } }]),
                "takes no option 'project'",
            ),
            (
                json!([{ "provider": "jira", "options": { "project": "" } }]),
                "options.project must be a non-empty string",
            ),
            (
                json!([{ "provider": "introspection", "options": { "x": "y" } }]),
                "takes no option 'x'",
            ),
            (
                json!([{ "provider": "linear", "options": ["ENG"] }]),
                "options must be an object",
            ),
            (
                json!([{ "provider": "acme", "package": "@acme/issues", "options": { "nested": {} } }]),
                "options.nested must be a non-empty string",
            ),
            (
                json!([{ "provider": "linear", "enabled": false }]),
                "applies only to the fallback",
            ),
            (
                json!([{ "provider": "introspection", "enabled": "no" }]),
                "must be a boolean",
            ),
            (
                json!([{ "provider": "linear" }, { "provider": "linear" }]),
                "more than once",
            ),
        ] {
            let report = check_recipe_files(&provider_recipe("issues", declarations, json!({})));
            assert!(
                invalid_with(&report, "pi.issues_invalid", text),
                "{text}: {:?}",
                report.diagnostics
            );
        }
    }

    #[test]
    fn productivity_declarations_accept_a_package_source() {
        let ok = check_recipe_files(&provider_recipe(
            "productivity",
            json!([{ "provider": "acme-mail", "package": "@acme/mail" }]),
            json!({ "@acme/mail": "1.0.0" }),
        ));
        assert!(
            !ok.diagnostics
                .iter()
                .any(|d| d.code == "pi.productivity_invalid"),
            "{:?}",
            ok.diagnostics
        );
        let missing = check_recipe_files(&provider_recipe(
            "productivity",
            json!([{ "provider": "acme-mail", "package": "@acme/mail" }]),
            json!({}),
        ));
        assert!(
            invalid_with(&missing, "pi.productivity_invalid", "@acme/mail"),
            "{:?}",
            missing.diagnostics
        );
        let mut peer_only = provider_recipe(
            "productivity",
            json!([{ "provider": "acme-mail", "package": "@acme/mail" }]),
            json!({}),
        );
        let package_file = peer_only
            .files
            .iter_mut()
            .find(|file| file.path == PACKAGE_JSON)
            .expect("package.json");
        let mut package: JsonValue =
            serde_json::from_str(package_file.content.as_deref().expect("content")).expect("parse");
        package["peerDependencies"] = json!({ "@acme/mail": ">=1.0.0" });
        package_file.content = Some(serde_json::to_string(&package).expect("serialize"));
        let peer_only = check_recipe_files(&peer_only);
        assert!(
            invalid_with(
                &peer_only,
                "pi.productivity_invalid",
                "package.json#dependencies"
            ),
            "{:?}",
            peer_only.diagnostics
        );
    }

    /// `connector_recipe` with its package.json changed by `edit`.
    fn edited_connector_recipe(edit: impl FnOnce(&mut JsonValue)) -> RecipeFiles {
        let mut files = connector_recipe(&["slack_origin"]);
        let package_file = files
            .files
            .iter_mut()
            .find(|file| file.path == PACKAGE_JSON)
            .expect("package.json");
        let mut package: JsonValue =
            serde_json::from_str(package_file.content.as_deref().expect("package content"))
                .expect("parse package");
        edit(&mut package);
        package_file.content = Some(serde_json::to_string_pretty(&package).expect("serialize"));
        files
    }

    fn channels_invalid_naming(report: &Report, package: &str) -> bool {
        report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "pi.channels_invalid" && diagnostic.message.contains(package)
        })
    }

    #[test]
    fn channel_package_may_be_a_peer_and_only_a_companion_may_be_omitted() {
        let omitted = check_recipe_files(&edited_connector_recipe(|package| {
            package
                .as_object_mut()
                .expect("package object")
                .remove("dependencies");
        }));
        assert!(omitted.valid, "{:?}", omitted.diagnostics);

        let as_peer = |provider: &str| {
            let provider = provider.to_owned();
            check_recipe_files(&edited_connector_recipe(move |package| {
                package
                    .as_object_mut()
                    .expect("package object")
                    .remove("dependencies");
                package["peerDependencies"] =
                    json!({ format!("@introspection-ai/recipe-channel-{provider}"): ">=0.1.0" });
                package["pi"]["channels"] = json!([{ "provider": provider }]);
            }))
        };
        let slack = as_peer("slack");
        assert!(slack.diagnostics.is_empty(), "{:?}", slack.diagnostics);
        let teams = as_peer("teams");
        assert!(teams.valid, "{:?}", teams.diagnostics);
        assert_eq!(
            codes(&teams),
            [("package.peer_not_provided_by_default", Severity::Warning)]
        );
    }

    /// The checker's host imports are Recipes and the keys of Recipes'
    /// `peerDependencies`.
    #[test]
    fn host_peer_packages_match_the_recipes_package() {
        let manifest: JsonValue = serde_json::from_str(include_str!("../../../package.json"))
            .expect("Recipes package.json must parse");
        let mut declared: BTreeSet<&str> = manifest["peerDependencies"]
            .as_object()
            .expect("peerDependencies must be an object")
            .keys()
            .map(String::as_str)
            .collect();
        declared.insert(manifest["name"].as_str().expect("name"));
        assert_eq!(
            declared,
            HOST_PEER_PACKAGES.into_iter().collect::<BTreeSet<_>>()
        );
    }

    #[test]
    fn channel_without_a_companion_requires_its_dependency() {
        let report = check_recipe_files(&edited_connector_recipe(|package| {
            package
                .as_object_mut()
                .expect("package object")
                .remove("dependencies");
            package["pi"]["channels"] = json!([{ "provider": "teams" }]);
        }));

        assert!(!report.valid);
        assert!(
            channels_invalid_naming(&report, "recipe-channel-teams"),
            "{:?}",
            report.diagnostics
        );
    }

    #[test]
    fn connector_dependency_needs_a_version_when_listed() {
        for invalid_version in [JsonValue::Null, json!("")] {
            let report = check_recipe_files(&edited_connector_recipe(|package| {
                package["dependencies"]["@introspection-ai/recipe-channel-slack"] = invalid_version;
            }));
            assert!(
                channels_invalid_naming(&report, "recipe-channel-slack"),
                "{:?}",
                report.diagnostics
            );
        }
    }

    #[test]
    fn accepts_generic_connector_declarations() {
        let report =
            check_recipe_files(&connector_recipe(&["slack_origin", "slack_custom_report"]));

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn connector_command_allowlist_shape() {
        for (commands, valid) in [
            (json!(["read", "reply"]), true),
            (json!([]), true),
            (json!(["read", "read"]), false),
            (json!([""]), false),
            (json!("read"), false),
            (json!([42]), false),
        ] {
            let mut files = connector_recipe(&["channels"]);
            let package_file = files
                .files
                .iter_mut()
                .find(|file| file.path == PACKAGE_JSON)
                .unwrap();
            let mut package: JsonValue =
                serde_json::from_str(package_file.content.as_deref().unwrap()).unwrap();
            package["pi"]["channels"][0]["commands"] = commands;
            package_file.content = Some(serde_json::to_string(&package).unwrap());
            let report = check_recipe_files(&files);
            assert_eq!(
                !report
                    .diagnostics
                    .iter()
                    .any(|d| d.code == "pi.channels_invalid"),
                valid
            );
        }
    }

    #[test]
    fn connector_required_reply_shape() {
        for value in [
            json!(true),
            json!(false),
            json!("true"),
            json!(1),
            JsonValue::Null,
        ] {
            let mut files = connector_recipe(&["channels"]);
            let package_file = files
                .files
                .iter_mut()
                .find(|file| file.path == PACKAGE_JSON)
                .unwrap();
            let mut package: JsonValue =
                serde_json::from_str(package_file.content.as_deref().unwrap()).unwrap();
            package["pi"]["channels"][0]["requireReply"] = value.clone();
            package_file.content = Some(serde_json::to_string(&package).unwrap());
            let report = check_recipe_files(&files);
            assert_eq!(
                !report
                    .diagnostics
                    .iter()
                    .any(|d| d.code == "pi.channels_invalid"),
                value.is_boolean()
            );
        }
    }

    #[test]
    fn connector_rejects_global_tool_configuration() {
        let mut files = connector_recipe(&["slack_origin"]);
        let package_file = files
            .files
            .iter_mut()
            .find(|file| file.path == PACKAGE_JSON)
            .expect("package.json");
        let mut package: JsonValue =
            serde_json::from_str(package_file.content.as_deref().expect("package content"))
                .expect("parse package");
        package["pi"]["channels"][0]["tools"] = json!({ "include": ["origin"] });
        package_file.content = Some(serde_json::to_string_pretty(&package).expect("serialize"));

        let report = check_recipe_files(&files);

        assert!(!report.valid);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "pi.channels_invalid"
                && diagnostic.message.contains("unknown field 'tools'")
        }));
    }

    #[test]
    fn accepts_package_and_agent_mcp_include_exclude_selectors() {
        let input = selector_recipe(
            json!({
                "include": ["*"],
                "exclude": ["delete_org"]
            }),
            concat!(
                "  mode: cli\n",
                "  servers:\n",
                "    salesforce:\n",
                "      include:\n",
                "        - '*'\n",
                "      exclude:\n",
                "        - export_all\n",
            ),
            true,
        );

        let report = check_recipe_files(&input);

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn accepts_structured_tools_mode_with_authorized_activation() {
        let input = selector_recipe(
            json!({ "include": ["search_profiles", "get_profile"] }),
            concat!(
                "  mode: tools\n",
                "  servers:\n",
                "    salesforce:\n",
                "      include:\n",
                "        - search_profiles\n",
                "        - get_profile\n",
                "      defer:\n",
                "        - '*'\n",
                "      eager:\n",
                "        - search_profiles\n",
            ),
            true,
        );

        let report = check_recipe_files(&input);

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn rejects_invalid_structured_mcp_mode_and_unknown_keys() {
        let input = selector_recipe(
            json!({ "include": ["search_profiles"] }),
            concat!(
                "  mode: deferred\n",
                "  servers:\n",
                "    salesforce:\n",
                "      include:\n",
                "        - search_profiles\n",
                "  initial_tools:\n",
                "    salesforce: search_profiles\n",
            ),
            true,
        );

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        for code in ["agent.mcp_mode_invalid", "agent.mcp_key_unknown"] {
            assert!(
                report
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == code),
                "missing {code}: {:?}",
                report.diagnostics
            );
        }
    }

    #[test]
    fn rejects_activation_outside_agent_authorization() {
        let input = selector_recipe(
            json!({ "include": ["search_profiles", "delete_profile"] }),
            concat!(
                "  mode: tools\n",
                "  servers:\n",
                "    salesforce:\n",
                "      include:\n",
                "        - search_profiles\n",
                "      eager:\n",
                "        - delete_profile\n",
            ),
            true,
        );

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "agent.mcp_activation_tool_unauthorized"
                && diagnostic.message.contains("salesforce/delete_profile")
        }));
    }

    #[test]
    fn accepts_independent_mcp_modes_across_visible_agent_tree() {
        let package = json!({
            "name": "mcp-mode-conflict",
            "version": "0.1.0",
            "pi": {
                "agents": ["agents/*.yaml"],
                "mcp": {
                    "servers": [{
                        "id": "salesforce",
                        "tools": { "include": ["search_profiles"] }
                    }]
                }
            }
        });
        let root = concat!(
            "name: root\n",
            "model:\n",
            "  name: test/provider-model\n",
            "tools: []\n",
            "mcp:\n",
            "  mode: tools\n",
            "  servers:\n",
            "    salesforce:\n",
            "      include:\n",
            "        - search_profiles\n",
            "subagents:\n",
            "  - child\n",
            "system_instructions:\n",
            "  content: Root instructions\n",
        );
        let child = concat!(
            "name: child\n",
            "model:\n",
            "  name: test/provider-model\n",
            "tools: []\n",
            "mcp:\n",
            "  mode: cli\n",
            "  servers:\n",
            "    salesforce:\n",
            "      include:\n",
            "        - search_profiles\n",
            "subagents: []\n",
            "system_instructions:\n",
            "  content: Child instructions\n",
        );
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("agents/root.yaml", root),
            ("agents/child.yaml", child),
        ]);

        let report = check_recipe_files(&input);

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    fn codemode_agent(servers: &str) -> String {
        format!(
            "name: root\nmodel:\n  name: test/provider-model\ntools: []\nmcp:\n  mode: codemode\n  servers:\n{servers}subagents: []\nsystem_instructions:\n  content: Root instructions\n"
        )
    }

    fn codemode_report(servers: &str) -> Report {
        let package = json!({
            "name": "mcp-codemode",
            "version": "0.1.0",
            "pi": {
                "agents": ["agents/*.yaml"],
                "mcp": {
                    "servers": [{
                        "id": "salesforce",
                        "tools": { "include": ["search_profiles", "get_profile"] }
                    }]
                }
            }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("agents/root.yaml", &codemode_agent(servers)),
        ]);
        check_recipe_files(&input)
    }

    #[test]
    fn accepts_codemode_with_eager_tools() {
        let report = codemode_report(concat!(
            "    salesforce:\n",
            "      include: [\"*\"]\n",
            "      eager: [search_profiles]\n",
        ));

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn rejects_defer_in_codemode() {
        let report = codemode_report(concat!(
            "    salesforce:\n",
            "      include: [\"*\"]\n",
            "      defer: [\"*\"]\n",
        ));

        assert!(!report.valid);
        assert!(report.diagnostics.iter().any(|diagnostic| diagnostic.code
            == "agent.mcp_activation_invalid"
            && diagnostic.message.contains("codemode")));
    }

    fn behind_report(mode: &str, server: &str) -> Report {
        let agent = codemode_agent(&format!(
            "    salesforce:\n      include: [\"*\"]\n{server}"
        ))
        .replace("tools: []", "tools: [crm]")
        .replace("mode: codemode", &format!("mode: {mode}"));
        let package = json!({
            "name": "mcp-behind",
            "version": "0.1.0",
            "pi": {
                "agents": ["agents/*.yaml"],
                "mcp": {
                    "servers": [{
                        "id": "salesforce",
                        "tools": { "include": ["search_profiles", "get_profile"] }
                    }]
                }
            }
        });
        check_recipe_files(&recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("agents/root.yaml", &agent),
        ]))
    }

    fn has_code(report: &Report, code: &str) -> bool {
        report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == code)
    }

    #[test]
    fn accepts_behind_naming_a_declared_tool_in_every_mode() {
        for mode in ["cli", "tools", "codemode"] {
            let report = behind_report(mode, "      behind: [crm]\n");
            assert!(report.valid, "{mode}: {:?}", report.diagnostics);
        }
    }

    #[test]
    fn rejects_behind_naming_an_undeclared_tool() {
        let report = behind_report("cli", "      behind: [mail]\n");
        assert!(!report.valid);
        assert!(has_code(&report, "agent.mcp_behind_tool_undeclared"));
    }

    #[test]
    fn rejects_malformed_behind() {
        for (server, code) in [
            ("      behind: []\n", "agent.mcp_invalid"),
            ("      behind: crm\n", "agent.mcp_invalid"),
            ("      behind: [\"*\"]\n", "agent.mcp_selector_invalid"),
            ("      behind: [crm, crm]\n", "agent.mcp_selector_duplicate"),
            (
                "      behind: [crm]\n      eager: [search_profiles]\n",
                "agent.mcp_behind_activation",
            ),
        ] {
            let report = behind_report("codemode", server);
            assert!(!report.valid, "{server}");
            assert!(
                has_code(&report, code),
                "{server}: {:?}",
                report.diagnostics
            );
        }
    }

    #[test]
    fn rejects_agent_exact_selector_excluded_by_package_policy() {
        let input = selector_recipe(
            json!({
                "include": ["*"],
                "exclude": ["delete_org"]
            }),
            "  mode: cli\n  servers:\n    salesforce:\n      include:\n        - delete_org\n",
            true,
        );

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "agent.mcp_tool_undeclared"
                && diagnostic.message.contains("salesforce/delete_org")
        }));
    }

    #[test]
    fn rejects_agent_server_without_package_policy_or_include() {
        let input = selector_recipe(
            json!({ "include": ["*"] }),
            "  mode: cli\n  servers:\n    ghost: {}\n",
            true,
        );

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "agent.mcp_server_undeclared" && diagnostic.message.contains("ghost")
        }));
    }

    #[test]
    fn rejects_duplicate_mcp_manifest_declarations() {
        let package = json!({
            "name": "duplicate-manifests",
            "pi": {
                "mcp": {
                    "manifests": ["mcp.json", "mcp.json"]
                }
            }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("mcp.json", "{}"),
        ]);

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "pi.mcp_invalid"
                && diagnostic.message.contains("duplicate entry 'mcp.json'")
        }));
    }

    #[test]
    fn checks_mcp_server_discovery() {
        let check = |discovery: &str| {
            let package = json!({
                "name": "discovery",
                "pi": {
                    "mcp": {
                        "servers": [
                            { "id": "contacts", "required": true, "discovery": discovery }
                        ]
                    }
                }
            });
            let input = recipe_files(&[(
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            )]);
            check_recipe_files(&input)
                .diagnostics
                .into_iter()
                .any(|diagnostic| {
                    diagnostic.code == "pi.mcp_invalid" && diagnostic.message.contains("discovery")
                })
        };

        assert!(!check("defer"));
        assert!(!check("require"));
        assert!(check("later"));
    }

    #[test]
    fn rejects_malformed_agent_mcp_selectors() {
        let input = selector_recipe(
            json!({ "include": ["*"] }),
            "  mode: cli\n  servers:\n    salesforce:\n      include:\n        - search_*\n",
            true,
        );

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.mcp_selector_invalid"));
    }

    #[test]
    fn rejects_non_object_agent_mcp_blocks() {
        let package = json!({
            "name": "invalid-agent-mcp-shape",
            "description": "Test",
            "pi": { "agents": ["agents/*.yaml"] }
        });
        let agent = concat!(
            "name: agent\n",
            "description: Test agent\n",
            "model:\n",
            "  name: test/provider-model\n",
            "  thinking_level: low\n",
            "tools: []\n",
            "mcp: []\n",
            "system_instructions:\n",
            "  content: Test instructions\n",
        );
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("agents/agent.yaml", agent),
        ]);

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.mcp_invalid"));
    }

    #[test]
    fn missing_agent_mcp_includes_are_silent_and_fail_closed() {
        let input = selector_recipe(
            json!({}),
            "  mode: cli\n  servers:\n    salesforce: {}\n",
            true,
        );

        let report = check_recipe_files(&input);

        assert!(report.valid, "{:?}", report.diagnostics);
        assert!(!report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "pi.mcp_include_missing"));
        assert!(!report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.mcp_include_missing"));

        let empty_agent_mcp = selector_recipe(
            json!({ "include": ["*"] }),
            "  mode: cli\n  servers: {}\n",
            true,
        );
        let empty_report = check_recipe_files(&empty_agent_mcp);
        assert!(empty_report.valid, "{:?}", empty_report.diagnostics);
        assert!(!empty_report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.mcp_empty"));
    }

    #[test]
    fn minimal_agent_requires_only_name_and_model_without_diagnostics() {
        let package = json!({
            "name": "agent-defaults",
            "description": "Test",
            "pi": { "agents": ["agents/*.yaml"] }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\n",
            ),
        ]);

        let report = check_recipe_files(&input);

        assert!(report.valid, "{:?}", report.diagnostics);
        assert!(report.diagnostics.is_empty(), "{:?}", report.diagnostics);

        let unnamed = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("agents/agent.yaml", "model:\n  name: test/provider-model\n"),
        ]);
        let unnamed_report = check_recipe_files(&unnamed);
        assert!(unnamed_report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.name_missing"));

        let non_string = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: 7\nmodel:\n  name: test/provider-model\n",
            ),
        ]);
        let non_string_report = check_recipe_files(&non_string);
        assert!(non_string_report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.name_invalid"));
    }

    #[test]
    fn rejects_session_generated_tool_names() {
        let package = json!({
            "name": "reserved-tools",
            "version": "0.1.0",
            "pi": { "agents": ["agents/*.yaml"] }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\ntools: [agent]\n",
            ),
        ]);

        let report = check_recipe_files(&input);

        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "agent.tools_reserved" && diagnostic.message.contains("agent")
        }));
    }

    #[test]
    fn accepts_extension_owned_tool_search() {
        let package = json!({
            "name": "extension-search",
            "version": "0.1.0",
            "pi": { "agents": ["agents/*.yaml"] }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\ntools: [tool_search]\n",
            ),
        ]);

        let report = check_recipe_files(&input);

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn accepts_ai_and_session_and_rejects_unsafe_ai_options() {
        let package = json!({
            "name": "agent-ai-session",
            "version": "0.1.0",
            "pi": { "agents": ["agents/*.yaml"] }
        });
        let manifest = serde_json::to_string_pretty(&package).expect("serialize package");
        let valid = recipe_files(&[
            ("package.json", &manifest),
            (
                "agents/agent.yaml",
                "name: agent\nai:\n  model: openai/gpt-5\n  thinking_level: high\n  options:\n    max_tokens: 4096\nsession:\n  steering_mode: one-at-a-time\n  follow_up_mode: all\n  tool_execution: parallel\n  retry:\n    max_retries: 3\n",
            ),
        ]);
        let report = check_recipe_files(&valid);
        assert!(report.valid, "{:?}", report.diagnostics);

        let unshipped_runtime_alias = recipe_files(&[
            ("package.json", &manifest),
            (
                "agents/agent.yaml",
                "name: agent\nai:\n  model: openai/gpt-5\nruntime:\n  tool_execution: parallel\n",
            ),
        ]);
        let report = check_recipe_files(&unshipped_runtime_alias);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.key_unknown"));

        let future_openrouter_routing = recipe_files(&[
            ("package.json", &manifest),
            (
                "agents/agent.yaml",
                "name: agent\nai:\n  model: openrouter/anthropic/claude-sonnet-4\n  providers:\n    openrouter:\n      routing:\n        future_router_policy:\n          mode: strict\n",
            ),
        ]);
        let report = check_recipe_files(&future_openrouter_routing);
        assert!(report.valid, "{:?}", report.diagnostics);

        let unsafe_options = recipe_files(&[
            ("package.json", &manifest),
            (
                "agents/agent.yaml",
                "name: agent\nai:\n  model: openai/gpt-5\n  options:\n    api_key: secret\n",
            ),
        ]);
        let report = check_recipe_files(&unsafe_options);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.ai.options_key_blocked"));
    }

    #[test]
    fn accepts_empty_pi_with_conventional_agents() {
        let package = json!({ "name": "minimal", "pi": {} });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\n",
            ),
        ]);

        let report = check_recipe_files(&input);

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn checks_agent_phases_as_a_list_of_names() {
        let package = json!({ "name": "phased", "pi": {} });
        let manifest = serde_json::to_string_pretty(&package).expect("serialize package");
        let agent = |phases: &str| {
            recipe_files(&[
                ("package.json", &manifest),
                (
                    "agents/agent.yaml",
                    &format!(
                        "name: agent\nmodel:\n  name: test/provider-model\nphases: {phases}\n"
                    ),
                ),
            ])
        };

        let report = check_recipe_files(&agent("[build, improve]"));
        assert!(report.valid, "{:?}", report.diagnostics);

        for (phases, code) in [
            ("build", "agent.phases_invalid"),
            ("[build, \"\"]", "agent.phases_invalid"),
            ("[build, build]", "agent.phases_duplicate"),
        ] {
            let report = check_recipe_files(&agent(phases));
            assert!(
                report
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == code),
                "{phases}: {:?}",
                report.diagnostics
            );
        }
    }

    #[test]
    fn rejects_unknown_and_noncanonical_agent_keys() {
        let package = json!({ "name": "canonical", "pi": {} });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\n  thinkingLevel: low\nprompt: legacy\n",
            ),
        ]);

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.model_key_unknown"));
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.key_unknown"));
    }

    #[test]
    fn rejects_whitespace_around_inherited_agent_names() {
        let package = json!({ "name": "canonical", "pi": {} });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/base.yaml",
                "name: base\nmodel:\n  name: test/provider-model\n",
            ),
            (
                "agents/child.yaml",
                "name: child\nfrom: \" base \"\nmodel:\n  name: test/provider-model\n",
            ),
        ]);

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.from_invalid"));
    }

    #[test]
    fn validates_only_declared_skill_and_subagent_references() {
        let package = json!({
            "name": "references",
            "pi": {
                "skills": ["skills"],
                "agents": ["agents"]
            }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\nskills: [missing]\nsubagents: [ghost]\n",
            ),
            (
                "skills/real/SKILL.md",
                "---\nname: real\ndescription: Real\n---\n",
            ),
        ]);

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.skill_missing"));
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.subagent_missing"));
    }

    /// A Recipe depending on `@acme/skills` (and `typebox` as a peer, `acme-dev`
    /// as a devDependency), with its agent selecting `agent_skills`, plus `extra`.
    fn add_peer_dependency(input: &mut RecipeFiles, name: &str) {
        let package = input
            .files
            .iter_mut()
            .find(|file| file.path == "package.json")
            .expect("package.json");
        let mut manifest: JsonValue =
            serde_json::from_str(package.content.as_deref().expect("content")).expect("json");
        manifest["peerDependencies"][name] = json!(">=1.0.0");
        package.content = Some(manifest.to_string());
    }

    fn dependency_skills_recipe(agent_skills: &str, extra: &[(&str, &str)]) -> RecipeFiles {
        let package = json!({
            "name": "dependency-skills",
            "dependencies": { "@acme/skills": ">=1.0.0" },
            "peerDependencies": { "typebox": "*" },
            "devDependencies": { "acme-dev": ">=1.0.0" },
            "pi": { "agents": ["agents"] }
        });
        let package = serde_json::to_string_pretty(&package).expect("serialize package");
        let agent =
            format!("name: agent\nmodel:\n  name: test/provider-model\nskills: [{agent_skills}]\n");
        let mut files = vec![
            ("package.json", package.as_str()),
            ("pnpm-lock.yaml", "lockfileVersion: '9.0'\n"),
            ("agents/agent.yaml", agent.as_str()),
        ];
        files.extend_from_slice(extra);
        recipe_files(&files)
    }

    const ACME_SKILLS: (&str, &str) = (
        "node_modules/@acme/skills/package.json",
        r#"{"name":"@acme/skills","pi":{"skills":["skills"]}}"#,
    );
    const ACME_REVIEW: (&str, &str) = (
        "node_modules/@acme/skills/skills/review/SKILL.md",
        "---\nname: review\ndescription: Review\n---\n",
    );

    fn codes(report: &Report) -> Vec<(&str, Severity)> {
        report
            .diagnostics
            .iter()
            .map(|diagnostic| (diagnostic.code.as_str(), diagnostic.severity))
            .collect()
    }

    #[test]
    fn offers_skills_a_direct_dependency_declares_in_pi_skills() {
        let report = check_recipe_files(&dependency_skills_recipe(
            "review",
            &[ACME_SKILLS, ACME_REVIEW],
        ));
        assert!(report.valid, "{:?}", report.diagnostics);
        assert!(report.diagnostics.is_empty(), "{:?}", report.diagnostics);
    }

    #[test]
    fn names_an_unnamed_root_skill_md_in_a_dependency_skill_as_the_runtime_does() {
        let root_skill = (
            "node_modules/@acme/skills/package.json",
            r#"{"name":"@acme/skills","pi":{"skills":["SKILL.md"]}}"#,
        );
        let unnamed = (
            "node_modules/@acme/skills/SKILL.md",
            "---\ndescription: Root\n---\n",
        );
        let report = check_recipe_files(&dependency_skills_recipe("skill", &[root_skill, unnamed]));
        assert!(report.valid, "{:?}", report.diagnostics);
        let report =
            check_recipe_files(&dependency_skills_recipe("skills", &[root_skill, unnamed]));
        assert_eq!(codes(&report), [("agent.skill_missing", Severity::Error)]);
    }

    #[test]
    fn names_an_unnamed_root_skill_md_in_a_peer_skill_as_the_runtime_does() {
        let mut input = dependency_skills_recipe(
            "skill",
            &[
                (
                    "node_modules/@acme/peer-skill/package.json",
                    r#"{"name":"@acme/peer-skill","pi":{"skills":["SKILL.md"]}}"#,
                ),
                (
                    "node_modules/@acme/peer-skill/SKILL.md",
                    "---\ndescription: Root\n---\n",
                ),
            ],
        );
        add_peer_dependency(&mut input, "@acme/peer-skill");

        let report = check_recipe_files(&input);
        assert!(report.valid, "{:?}", report.diagnostics);
        assert!(
            !report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code.starts_with("agent.")),
            "{:?}",
            report.diagnostics
        );
    }

    #[test]
    fn offers_skills_a_peer_declares_and_warns_the_platform_must_provide_it() {
        let mut input = dependency_skills_recipe(
            "contracts",
            &[
                (
                    "node_modules/acme-peer/package.json",
                    r#"{"name":"acme-peer","pi":{"skills":["skills"]}}"#,
                ),
                (
                    "node_modules/acme-peer/skills/contracts/SKILL.md",
                    "---\nname: contracts\ndescription: Contracts\n---\n",
                ),
            ],
        );
        add_peer_dependency(&mut input, "acme-peer");

        let report = check_recipe_files(&input);
        assert_eq!(
            codes(&report),
            [("package.peer_not_provided_by_default", Severity::Warning)]
        );
        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn ignores_dependency_skills_without_explicit_pi_skills_and_from_dev_and_transitive_packages() {
        let skill = |name: &'static str| (name, "---\nname: hidden\ndescription: Hidden\n---\n");
        // The Recipe also depends on acme-visible, whose skill is offered.
        let mut input = dependency_skills_recipe(
            "visible, hidden",
            &[
                (
                    "node_modules/acme-visible/package.json",
                    r#"{"name":"acme-visible","pi":{"skills":["skills"]}}"#,
                ),
                (
                    "node_modules/acme-visible/skills/visible/SKILL.md",
                    "---\nname: visible\ndescription: Visible\n---\n",
                ),
                // Installed direct dependency without pi.skills: its skills/ folder is not read.
                (
                    "node_modules/@acme/skills/package.json",
                    r#"{"name":"@acme/skills"}"#,
                ),
                skill("node_modules/@acme/skills/skills/hidden/SKILL.md"),
                (
                    "node_modules/acme-dev/package.json",
                    r#"{"name":"acme-dev","pi":{"skills":["skills"]}}"#,
                ),
                skill("node_modules/acme-dev/skills/hidden/SKILL.md"),
                (
                    "node_modules/acme-transitive/package.json",
                    r#"{"name":"acme-transitive","pi":{"skills":["skills"]}}"#,
                ),
                skill("node_modules/acme-transitive/skills/hidden/SKILL.md"),
            ],
        );
        let package = input
            .files
            .iter_mut()
            .find(|file| file.path == "package.json")
            .expect("package.json");
        let mut manifest: JsonValue =
            serde_json::from_str(package.content.as_deref().expect("content")).expect("json");
        manifest["dependencies"]["acme-visible"] = json!(">=1.0.0");
        package.content = Some(manifest.to_string());

        let report = check_recipe_files(&input);
        assert_eq!(codes(&report), [("agent.skill_missing", Severity::Error)]);
        assert!(
            report.diagnostics[0].message.contains("'hidden'"),
            "{:?}",
            report.diagnostics
        );
    }

    #[test]
    fn warns_instead_of_failing_when_a_dependency_is_not_installed() {
        let report = check_recipe_files(&dependency_skills_recipe("review", &[]));
        assert!(report.valid, "{:?}", report.diagnostics);
        assert_eq!(
            codes(&report),
            [("agent.skill_unverified", Severity::Warning)]
        );
        assert!(report.diagnostics[0].message.contains("@acme/skills"));
    }

    #[test]
    fn rejects_a_selected_skill_name_shipped_twice_across_packages() {
        let report = check_recipe_files(&dependency_skills_recipe(
            "review",
            &[
                ACME_SKILLS,
                ACME_REVIEW,
                (
                    "skills/review/SKILL.md",
                    "---\nname: review\ndescription: Own\n---\n",
                ),
            ],
        ));
        assert_eq!(codes(&report), [("agent.skill_ambiguous", Severity::Error)]);
        let message = &report.diagnostics[0].message;
        assert!(message.contains("skills/review/SKILL.md"), "{message}");
        assert!(
            message.contains("node_modules/@acme/skills/skills/review/SKILL.md"),
            "{message}"
        );
    }

    #[test]
    fn rejects_dependency_skill_paths_that_do_not_match_or_leave_the_package() {
        for (skills, code) in [
            (r#"["missing"]"#, "dependency.skills_unmatched"),
            (r#"["../escape"]"#, "dependency.skills_invalid"),
            (r#""skills""#, "dependency.skills_invalid"),
        ] {
            let manifest = format!(r#"{{"name":"@acme/skills","pi":{{"skills":{skills}}}}}"#);
            let report = check_recipe_files(&dependency_skills_recipe(
                "",
                &[
                    ("node_modules/@acme/skills/package.json", &manifest),
                    ACME_REVIEW,
                ],
            ));
            assert_eq!(codes(&report), [(code, Severity::Error)], "{skills}");
            assert!(
                report.diagnostics[0].message.contains("'@acme/skills'"),
                "{skills}"
            );
        }
    }

    #[test]
    fn accepts_resolved_references_and_package_extensions() {
        let package = json!({
            "name": "references",
            "pi": {
                "skills": ["skills"],
                "agents": ["agents"],
                "extensions": ["extensions/tools.ts"]
            }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\nskills: [public-skill]\nsubagents: [helper]\n",
            ),
            (
                "agents/helper.yaml",
                "name: helper\nmodel:\n  name: test/provider-model\n",
            ),
            (
                "skills/folder/SKILL.md",
                "---\nname: public-skill\ndescription: Real\n---\n",
            ),
            ("extensions/tools.ts", "export default () => {};\n"),
        ]);

        let report = check_recipe_files(&input);

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn rejects_unmatched_explicit_resource_patterns() {
        let package = json!({
            "name": "optional-resources",
            "pi": {
                "agents": ["agents/*.yaml"],
                "skills": ["skills/*"],
                "prompts": ["prompts/*.md"]
            }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\n",
            ),
        ]);

        let report = check_recipe_files(&input);

        assert!(!report.valid, "{:?}", report.diagnostics);
        for code in ["package.skills_unmatched", "package.prompts_unmatched"] {
            assert!(report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == code));
        }

        let direct_package = json!({
            "name": "missing-direct-resource",
            "pi": {
                "agents": ["agents/*.yaml"],
                "skills": ["skills/missing"]
            }
        });
        let direct_input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&direct_package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\n",
            ),
        ]);
        let direct_report = check_recipe_files(&direct_input);
        assert!(direct_report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "package.skills_unmatched"));
    }

    #[test]
    fn skill_discovery_stops_at_the_first_skill_file() {
        let package = json!({
            "name": "nested-skills",
            "pi": { "agents": ["agents"], "skills": ["skills/root"] }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\nskills: [nested]\n",
            ),
            ("skills/root/SKILL.md", "---\nname: root\n---\n"),
            ("skills/root/nested/SKILL.md", "---\nname: nested\n---\n"),
        ]);

        let report = check_recipe_files(&input);

        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.skill_missing"));
    }

    #[test]
    fn malformed_skill_frontmatter_uses_the_directory_name() {
        let package = json!({
            "name": "skill-frontmatter",
            "pi": { "agents": ["agents"], "skills": ["skills"] }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\nskills: [fake]\n",
            ),
            (
                "skills/real/SKILL.md",
                "---\nname: fake\n---garbage\ncontent\n",
            ),
        ]);

        let report = check_recipe_files(&input);

        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.skill_missing"));
    }

    #[test]
    fn inherited_reference_failures_are_reported_once_at_the_declaration() {
        let package = json!({
            "name": "inherited-reference",
            "pi": { "agents": ["agents"] }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/base.yaml",
                "name: base\nmodel:\n  name: test/provider-model\nsubagents: [missing]\n",
            ),
            ("agents/agent.yaml", "name: agent\nfrom: base\n"),
        ]);

        let report = check_recipe_files(&input);

        assert_eq!(
            report
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code == "agent.subagent_missing")
                .count(),
            1
        );
    }

    #[test]
    fn rejects_unknown_recipe_keys_generically() {
        let package = json!({
            "name": "unknown-key",
            "pi": {
                "agents": ["agents/*.yaml"],
                "future_key": {}
            }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\n  thinking_level: low\ntools: []\nsystem_instructions:\n  content: Test\n",
            ),
        ]);

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "pi.unknown_key"));
    }

    #[test]
    fn validates_runtime_requirement_paths_and_shapes() {
        let package = json!({
            "name": "runtime-requirements",
            "pi": {
                "agents": ["agents/*.yaml"],
                "runtime": {
                    "python": {
                        "project": "python",
                        "lockfile": "python/uv.lock",
                        "version": ">=3.12,<3.15",
                        "imports": ["pandas", "openpyxl"]
                    }
                }
            }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\n",
            ),
            ("python/pyproject.toml", "[project]\nname='controls'\n"),
            ("python/uv.lock", "version = 1\n"),
        ]);

        let report = check_recipe_files(&input);

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn rejects_runtime_system_as_an_unknown_runtime_field() {
        let package = json!({
            "name": "runtime-system",
            "pi": {
                "agents": ["agents/*.yaml"],
                "runtime": {
                    "system": {
                        "packages": [
                            { "id": "document.pdf-tools", "version": "1" }
                        ]
                    }
                }
            }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\n",
            ),
        ]);

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "pi.runtime_invalid"
                && diagnostic.message == "package.json#pi.runtime contains unknown field 'system'"
        }));
    }

    #[test]
    fn rejects_python_imports_that_are_not_dotted_module_names() {
        let package = json!({
            "name": "runtime-imports",
            "pi": {
                "agents": ["agents/*.yaml"],
                "runtime": {
                    "python": {
                        "project": "python",
                        "lockfile": "python/uv.lock",
                        "imports": ["paper_docx.api", "python-docx", "os; import sys"]
                    }
                }
            }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\n",
            ),
            ("python/pyproject.toml", "[project]\nname='controls'\n"),
            ("python/uv.lock", "version = 1\n"),
        ]);

        let report = check_recipe_files(&input);

        let messages: Vec<_> = report
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code == "pi.runtime_invalid")
            .map(|diagnostic| diagnostic.message.clone())
            .collect();
        assert_eq!(messages.len(), 2, "{messages:?}");
        assert!(messages[0].contains("'python-docx'"));
        assert!(messages[1].contains("'os; import sys'"));
        assert!(is_python_module_name("_private.mod2"));
        assert!(!is_python_module_name("2fast"));
        assert!(!is_python_module_name("a..b"));
    }

    #[test]
    fn rejects_agent_mcp_access_without_package_server_policy() {
        let mut input = selector_recipe(
            json!({ "include": ["search_profiles"] }),
            "  mode: cli\n  servers:\n    salesforce:\n      include:\n        - search_profiles\n",
            true,
        );
        let package = json!({
            "name": "mcp-policy-missing-test",
            "version": "0.1.0",
            "pi": { "agents": ["agents/*.yaml"] }
        });
        input.files[0] = RecipeFile::new(
            "package.json",
            serde_json::to_string_pretty(&package).expect("serialize package"),
        );

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "agent.mcp_server_undeclared"
                && diagnostic.message.contains("salesforce")
        }));
    }

    #[test]
    fn reports_missing_package_manifest() {
        let report = check_recipe_files(&RecipeFiles::default());

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "package.manifest_missing"));
    }

    #[test]
    fn reports_unread_file_content_as_unreadable() {
        let input = RecipeFiles {
            files: vec![RecipeFile::unread("package.json")],
            directories: Vec::new(),
        };

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "package.manifest_unreadable"));
    }

    #[test]
    fn malformed_package_json_has_span() {
        let input = recipe_files(&[("package.json", "{\n  \"name\": ,\n}\n")]);

        let report = check_recipe_files(&input);

        let diagnostic = report
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == "package.manifest_malformed")
            .expect("malformed diagnostic");
        let span = diagnostic.span.expect("span");
        assert_eq!(span.line, 2);
    }

    #[test]
    fn resolves_agents_from_conventional_directory() {
        let package = json!({
            "name": "conventional-agents",
            "description": "Test",
            "pi": { "agents": ["agents"] }
        });
        let agent = concat!(
            "name: helper\n",
            "description: Helper agent\n",
            "model:\n",
            "  name: test/provider-model\n",
            "  thinking_level: low\n",
            "tools: []\n",
            "skills: []\n",
            "subagents: []\n",
            "system_instructions:\n",
            "  content: Test instructions\n",
        );
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("agents/helper.yaml", agent),
            ("agents/notes.md", "not an agent\n"),
            ("agents/nested/inner.yaml", "name: inner\n"),
        ]);

        let report = check_recipe_files(&input);

        assert!(report.valid, "{:?}", report.diagnostics);
    }

    #[test]
    fn malformed_agent_yaml_is_reported() {
        let package = json!({
            "name": "malformed-agent",
            "description": "Test",
            "pi": { "agents": ["agents/*.yaml"] }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("agents/agent.yaml", "name: [unterminated\n"),
        ]);

        let report = check_recipe_files(&input);

        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "agent.yaml_malformed"));
    }

    #[test]
    fn a_missing_lockfile_warns_without_invalidating_the_recipe() {
        let package = json!({
            "name": "dependency-recipe",
            "pi": {},
            "dependencies": { "example": "1.0.0" }
        });
        let mut input = recipe_files(&[(
            "package.json",
            &serde_json::to_string_pretty(&package).expect("serialize package"),
        )]);

        let missing = check_recipe_files(&input);
        let warning = missing
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == "package.lockfile_missing")
            .expect("lockfile_missing diagnostic");
        assert_eq!(warning.severity, Severity::Warning);

        input.files.push(RecipeFile::new(
            "pnpm-lock.yaml",
            "lockfileVersion: '9.0'\n",
        ));
        let locked = check_recipe_files(&input);
        assert!(!locked
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "package.lockfile_missing"));
        assert_eq!(missing.valid, locked.valid);
    }

    #[test]
    fn a_foreign_package_manager_is_rejected() {
        // Verified against Corepack 0.34.6: everything false here aborts the
        // documented install rather than merely naming another manager.
        for (declared, valid) in [
            ("pnpm@10.33.0", true),
            ("pnpm@10.33.0+sha512.abc123", true),
            ("pnpm@10.33.0-beta.1", true),
            ("pnpm", false),
            ("pnpm@bogus", false),
            ("pnpm@10.33", false),
            ("npm@10.9.0", false),
            ("yarn@4.0.0", false),
        ] {
            let package = json!({
                "name": "managed-recipe",
                "pi": {},
                "packageManager": declared
            });
            let input = recipe_files(&[(
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            )]);

            let report = check_recipe_files(&input);

            let rejected = report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "package.package_manager_not_pnpm");
            assert_eq!(!rejected, valid, "packageManager {declared}");
        }
    }

    #[test]
    fn an_npm_lockfile_never_satisfies_the_requirement() {
        // It used to: the check accepted four names while the runtime installs
        // with pnpm, so a Recipe validated green and then failed to install.
        let package = json!({
            "name": "npm-locked-recipe",
            "pi": {},
            "dependencies": { "example": "1.0.0" }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("package-lock.json", "{\"lockfileVersion\": 3}"),
        ]);

        let report = check_recipe_files(&input);

        let codes: Vec<&str> = report
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect();
        assert!(codes.contains(&"package.lockfile_missing"));
        assert!(codes.contains(&"package.lockfile_not_pnpm"));
    }

    #[test]
    fn a_committed_local_binding_is_accepted_only_as_an_evaluation_binding() {
        for (content, accepted) in [
            (r#"{"servers":[]}"#, true),
            (r#"{}"#, true),
            (
                r#"{"servers":[{"id":"attio","transport":"streamable_http","url":"http://localhost:4318/attio/mcp"},{"id":"resend","url":"http://127.0.0.1:4318/resend/mcp","headers":{"X-Fake":"1"}}]}"#,
                true,
            ),
            (
                r#"{"servers":[{"id":"a","url":"https://[::1]:8443/mcp"}]}"#,
                true,
            ),
            (
                r#"{"servers":[{"id":"a","url":"http://LOCALHOST/mcp"}]}"#,
                true,
            ),
            (
                r#"{"servers":[{"id":"a","url":"https://contacts.example.com/mcp"}]}"#,
                false,
            ),
            (
                r#"{"servers":[{"id":"attio","url":"http://fakes:7353/attio/mcp"},{"id":"resend","url":"http://fakes:7353/resend/mcp"}]}"#,
                true,
            ),
            (
                r#"{"servers":[{"id":"google_calendar","url":"http://google-calendar:8000/mcp"}]}"#,
                true,
            ),
            (
                r#"{"servers":[{"id":"a","url":"http://fake-attio.internal:4318/mcp"}]}"#,
                false,
            ),
            (
                r#"{"servers":[{"id":"a","url":"http://-fakes:4318/mcp"}]}"#,
                false,
            ),
            (
                r#"{"servers":[{"id":"undeclared","url":"http://localhost/mcp"}]}"#,
                false,
            ),
            (r#"{"servers":[{"url":"http://localhost/mcp"}]}"#, false),
            (
                r#"{"servers":[{"id":"a","url":"http://localhost/mcp"},{"id":"A","url":"http://fakes/mcp"}]}"#,
                false,
            ),
            (
                r#"{"servers":[{"id":"a","url":"http://10.0.0.1/mcp"}]}"#,
                false,
            ),
            (
                r#"{"servers":[{"id":"a","url":"${ATTIO_MCP_URL}"}]}"#,
                false,
            ),
            (
                r#"{"servers":[{"id":"a","url":"ws://localhost:4318/mcp"}]}"#,
                false,
            ),
            (
                r#"{"servers":[{"id":"a","transport":"stdio","url":"http://localhost/mcp"}]}"#,
                false,
            ),
            (
                r#"{"servers":[{"id":"a","url":"http://localhost/mcp","auth":"oauth"}]}"#,
                false,
            ),
            (
                r#"{"servers":[{"id":"a","url":"http://localhost/mcp","command":"npx"}]}"#,
                false,
            ),
            (
                r#"{"servers":[{"id":"a","url":"http://localhost/mcp","headers":{"X":1}}]}"#,
                false,
            ),
            (r#"{"servers":[{"id":"a"}]}"#, false),
            (r#"{"servers":["a"]}"#, false),
            (r#"{"servers":{}}"#, false),
            (r#"[]"#, false),
            (r#"{"#, false),
        ] {
            let package = json!({
                "name": "local-config-recipe",
                "pi": { "mcp": { "servers": [
                    { "id": "a" },
                    { "id": "attio" },
                    { "id": "resend" },
                    { "id": "google_calendar" },
                ] } },
            });
            let input = recipe_files(&[
                (
                    "package.json",
                    &serde_json::to_string_pretty(&package).expect("serialize package"),
                ),
                (".pi/mcp.local.json", content),
            ]);

            let report = check_recipe_files(&input);
            let rejected = report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "package.local_config_present");
            assert_eq!(!rejected, accepted, "{content}: {:?}", report.diagnostics);
        }
    }

    #[test]
    fn a_committed_local_binding_without_content_is_rejected() {
        let package = json!({ "name": "local-config-recipe", "pi": {} });
        let input = RecipeFiles {
            files: vec![
                RecipeFile::new(
                    "package.json",
                    serde_json::to_string_pretty(&package).expect("serialize package"),
                ),
                RecipeFile {
                    path: ".pi/mcp.local.json".to_owned(),
                    content: None,
                },
            ],
            directories: Vec::new(),
        };

        let report = check_recipe_files(&input);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "package.local_config_present"));
    }

    #[test]
    fn validates_the_redacted_local_mcp_example() {
        let package = json!({ "name": "local-example-recipe", "pi": {} });
        let valid = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                ".pi/mcp.local.example.json",
                r#"{"servers":[{"id":"search","url":"https://example.test/mcp","headers":{"Authorization":"Bearer ${TOKEN}"}}]}"#,
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/model\n",
            ),
        ]);
        let valid_report = check_recipe_files(&valid);
        assert!(valid_report.valid, "{:?}", valid_report.diagnostics);

        let invalid = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                ".pi/mcp.local.example.json",
                r#"{"servers":[{"id":"","headers":{"Authorization":42}}]}"#,
            ),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/model\n",
            ),
        ]);
        let report = check_recipe_files(&invalid);
        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "mcp.local_example_invalid"));
    }

    #[test]
    fn validates_npm_lockfile_identity_and_json() {
        let package = json!({
            "name": "owned-recipe",
            "version": "0.2.0",
            "pi": {}
        });
        let mismatched_lock = json!({
            "name": "upstream-recipe",
            "version": "0.1.0",
            "lockfileVersion": 3,
            "packages": {
                "": { "name": "upstream-recipe", "version": "0.1.0" }
            }
        });
        let input = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            (
                "package-lock.json",
                &serde_json::to_string_pretty(&mismatched_lock).expect("serialize lockfile"),
            ),
        ]);

        let report = check_recipe_files(&input);
        let codes = report
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_str())
            .collect::<BTreeSet<_>>();
        assert!(codes.contains("package.lockfile_name_mismatch"));
        assert!(codes.contains("package.lockfile_version_mismatch"));

        let malformed = recipe_files(&[
            (
                "package.json",
                &serde_json::to_string_pretty(&package).expect("serialize package"),
            ),
            ("package-lock.json", "{"),
        ]);
        assert!(check_recipe_files(&malformed)
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "package.lockfile_malformed"));
    }

    const HARBOR_TASK_TOML: &str = "version = \"1.0\"\n\n[verifier]\ntimeout_sec = 120\n";
    const APPROVED_CASE: &str = "---\nid: greet\ntitle: Greets the user\ncheck: code\napproved_by: owner@example.com\napproved_at: 2026-11-04\napproved_in: msg_1\n---\n\n## Situation\nThe user says hello.\n";

    /// A Recipe whose `pi` carries `evals` (when given) plus `extra` files.
    fn evals_recipe(evals: Option<JsonValue>, extra: &[(&str, &str)]) -> RecipeFiles {
        let mut pi = json!({ "agents": ["agents/*.yaml"] });
        if let Some(evals) = evals {
            pi["evals"] = evals;
        }
        let package = serde_json::to_string_pretty(&json!({ "name": "evals-test", "pi": pi }))
            .expect("serialize package");
        let mut files = vec![
            ("package.json", package.as_str()),
            (
                "agents/agent.yaml",
                "name: agent\nmodel:\n  name: test/provider-model\n",
            ),
        ];
        files.extend_from_slice(extra);
        recipe_files(&files)
    }

    fn evals_diagnostics(report: &Report) -> Vec<&Diagnostic> {
        report
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code.starts_with("pi.evals_"))
            .collect()
    }

    fn assert_single(report: &Report, code: &str, severity: Severity, needle: &str) {
        let found = evals_diagnostics(report);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].code, code, "{found:?}");
        assert_eq!(found[0].severity, severity, "{found:?}");
        assert!(found[0].message.contains(needle), "{found:?}");
    }

    #[test]
    fn evals_full_block_is_valid() {
        let input = evals_recipe(
            Some(json!({
                "suites": [
                    { "type": "harbor", "path": "evals/harbor" },
                    { "type": "vitest", "path": "evals/vitest" },
                    { "type": "vitest", "path": "evals/vitest-slow" }
                ],
                "lib": "evals/lib",
                "sources": "evals/sources",
                "fakes": "evals/fakes"
            })),
            &[
                (".recipeignore", "# authoring only\nevals/\n"),
                ("evals/README.md", "# Evals\n"),
                ("evals/harbor/greet/task.toml", HARBOR_TASK_TOML),
                ("evals/harbor/greet/instruction.md", "Say hello\n"),
                ("evals/vitest/greet.eval.ts", "export {};\n"),
                ("evals/vitest-slow/long.eval.ts", "export {};\n"),
                ("evals/lib/grader.ts", "export {};\n"),
                ("evals/sources/gen.ts", "export {};\n"),
                // Fakes kept under evals/ pass by naming the path.
                ("evals/fakes/hello-mcp/server.ts", "export {};\n"),
                ("evals/cases/greet.md", APPROVED_CASE),
            ],
        );
        let report = check_recipe_files(&input);
        assert!(report.valid, "{:?}", report.diagnostics);
        assert!(report.diagnostics.is_empty(), "{:?}", report.diagnostics);
    }

    #[test]
    fn evals_absent_block_discovers_default_suites() {
        let tree = [
            ("evals/harbor/greet/task.toml", HARBOR_TASK_TOML),
            ("evals/harbor/greet/tests/test.sh", "exit 0\n"),
            ("evals/vitest/greet.eval.ts", "export {};\n"),
            ("evals/lib/judge.ts", "export {};\n"),
        ];
        let mut ignored = tree.to_vec();
        ignored.push((".recipeignore", "evals/\n"));
        let report = check_recipe_files(&evals_recipe(None, &ignored));
        assert!(report.diagnostics.is_empty(), "{:?}", report.diagnostics);

        // Without .recipeignore every discovered path that exists warns, and
        // the defaults count as eval paths, so nothing is reported as stray.
        let report = check_recipe_files(&evals_recipe(None, &tree));
        assert!(report.valid, "{:?}", report.diagnostics);
        let mut not_ignored: Vec<&str> = evals_diagnostics(&report)
            .iter()
            .map(|diagnostic| {
                assert_eq!(diagnostic.code, "pi.evals_not_ignored", "{diagnostic:?}");
                assert_eq!(diagnostic.severity, Severity::Warning);
                diagnostic.message.as_str()
            })
            .collect();
        not_ignored.sort_unstable();
        assert_eq!(
            not_ignored,
            [
                "eval path 'evals/harbor' is not excluded by .recipeignore",
                "eval path 'evals/lib' is not excluded by .recipeignore",
                "eval path 'evals/vitest' is not excluded by .recipeignore",
            ]
        );

        // No eval directories at all: nothing to check.
        let report = check_recipe_files(&evals_recipe(None, &[]));
        assert!(report.diagnostics.is_empty(), "{:?}", report.diagnostics);
    }

    #[test]
    fn evals_shape_errors() {
        let cases: Vec<(JsonValue, &str, &str)> = vec![
            (
                json!([]),
                "pi.evals_invalid",
                "package.json#pi.evals must be an object",
            ),
            (
                json!({ "suite": [] }),
                "pi.evals_invalid",
                "unknown key 'suite'",
            ),
            (
                json!({ "suites": {} }),
                "pi.evals_invalid",
                "suites must be an array",
            ),
            (
                json!({ "suites": ["evals/harbor"] }),
                "pi.evals_invalid",
                "suites[0] must be an object",
            ),
            (
                json!({ "suites": [{ "type": "harbor", "path": "evals/harbor", "name": "x" }] }),
                "pi.evals_invalid",
                "suites[0] contains unknown field 'name'",
            ),
            (
                json!({ "suites": [{ "type": "pytest", "path": "evals/harbor" }] }),
                "pi.evals_invalid",
                "suites[0].type must be 'harbor' or 'vitest'",
            ),
            (
                json!({ "suites": [{ "path": "evals/harbor" }] }),
                "pi.evals_invalid",
                "suites[0].type must be 'harbor' or 'vitest'",
            ),
            (
                json!({ "suites": [{ "type": "harbor" }] }),
                "pi.evals_invalid",
                "suites[0].path is required",
            ),
            (
                json!({ "suites": [{ "type": "harbor", "path": 3 }] }),
                "pi.evals_invalid",
                "suites[0].path must be a string path",
            ),
            (
                json!({ "lib": ["evals/lib"] }),
                "pi.evals_invalid",
                "pi.evals.lib must be a string path",
            ),
            (
                json!({ "suites": [
                    { "type": "harbor", "path": "evals/harbor" },
                    { "type": "vitest", "path": "./evals/harbor/" }
                ] }),
                "pi.evals_invalid",
                "duplicate path 'evals/harbor'",
            ),
        ];
        for (evals, code, needle) in cases {
            let input = evals_recipe(
                Some(evals.clone()),
                &[
                    (".recipeignore", "evals/\n"),
                    ("evals/harbor/greet/task.toml", HARBOR_TASK_TOML),
                ],
            );
            let report = check_recipe_files(&input);
            assert!(!report.valid, "{evals}: {:?}", report.diagnostics);
            assert_single(&report, code, Severity::Error, needle);
        }
    }

    #[test]
    fn evals_path_errors() {
        let cases = [
            ("", "must be non-empty"),
            ("evals\\harbor", "must use '/' separators"),
            ("/evals/harbor", "must be relative to the package root"),
            ("C:/evals", "must be relative to the package root"),
            ("../shared/evals", "must stay inside the package"),
            ("evals/../../outside", "must stay inside the package"),
            ("evals/*", "must be a path, not a glob pattern"),
            (".", "must name a directory below the package root"),
            ("evals//harbor", "must be a normalized path"),
            ("evals/./harbor", "must be a normalized path"),
        ];
        for (path, needle) in cases {
            for evals in [
                json!({ "suites": [{ "type": "harbor", "path": path }] }),
                json!({ "suites": [], "fakes": path }),
            ] {
                let report = check_recipe_files(&evals_recipe(Some(evals.clone()), &[]));
                assert!(!report.valid, "{evals}: {:?}", report.diagnostics);
                assert_single(&report, "pi.evals_path_invalid", Severity::Error, needle);
            }
        }
    }

    #[test]
    fn evals_configured_suite_must_exist() {
        let input = evals_recipe(
            Some(json!({ "suites": [{ "type": "vitest", "path": "evals/vitest" }] })),
            &[(".recipeignore", "evals/\n")],
        );
        let report = check_recipe_files(&input);
        assert!(!report.valid, "{:?}", report.diagnostics);
        assert_single(
            &report,
            "pi.evals_suite_missing",
            Severity::Error,
            "suite path 'evals/vitest' does not exist",
        );

        // An empty directory exists.
        let mut input = input;
        input.directories.push("evals/vitest".to_owned());
        let report = check_recipe_files(&input);
        assert!(report.diagnostics.is_empty(), "{:?}", report.diagnostics);

        // Explicit empty suites opt out of discovery; missing lib/sources/fakes
        // are not errors.
        let input = evals_recipe(
            Some(json!({ "suites": [], "lib": "evals/shared" })),
            &[("evals/harbor/greet/task.toml", HARBOR_TASK_TOML)],
        );
        let report = check_recipe_files(&input);
        assert!(report.valid, "{:?}", report.diagnostics);
        assert_single(
            &report,
            "pi.evals_stray_content",
            Severity::Warning,
            "'evals/harbor/greet/task.toml' looks like a Harbor task",
        );
    }

    #[test]
    fn evals_harbor_task_without_task_toml_warns() {
        // An empty block adopts the layout checks with every default path.
        let input = evals_recipe(
            Some(json!({})),
            &[
                (".recipeignore", "evals/\n"),
                ("evals/harbor/greet/task.toml", HARBOR_TASK_TOML),
                ("evals/cases/greet.md", APPROVED_CASE),
                ("evals/harbor/shared/helpers.py", "\n"),
                ("evals/harbor/README.md", "# Tasks\n"),
            ],
        );
        let report = check_recipe_files(&input);
        assert!(report.valid, "{:?}", report.diagnostics);
        assert_single(
            &report,
            "pi.evals_task_missing",
            Severity::Warning,
            "Harbor task folder 'evals/harbor/shared' has no task.toml",
        );
        assert_eq!(evals_diagnostics(&report)[0].path, "evals/harbor/shared");

        // Vitest suites have no task folders.
        let input = evals_recipe(
            None,
            &[
                (".recipeignore", "evals/\n"),
                ("evals/vitest/fixtures/a.jsonl", "{}\n"),
            ],
        );
        assert!(check_recipe_files(&input).diagnostics.is_empty());
    }

    #[test]
    fn evals_recipeignore_coverage() {
        let tree = [
            ("evals/harbor/greet/task.toml", HARBOR_TASK_TOML),
            ("fakes/hello-mcp/server.ts", "export {};\n"),
        ];
        let covered = [
            "evals/\nfakes/\n",
            "/evals\n/fakes\n",
            "evals\nfakes\n",
            "evals/*\nfakes/\n",
            "evals/harbor/\nfakes/\n",
            // A negation below an excluded directory cannot re-include it.
            "evals/\nfakes/\n!evals/harbor/greet\n",
            "evals/\nfakes/\n!fakes/hello-mcp/\n",
        ];
        for ignore in covered {
            let mut files = tree.to_vec();
            files.push((".recipeignore", ignore));
            let report = check_recipe_files(&evals_recipe(None, &files));
            assert!(
                report.diagnostics.is_empty(),
                "{ignore:?}: {:?}",
                report.diagnostics
            );
        }

        let partial = [
            ("evals/\n", "'fakes'"),
            ("evals/harbor/*/tests/\nfakes\n", "'evals/harbor'"),
            ("fakes/hello-mcp\nevals/harbor/\n", "'fakes'"),
        ];
        for (ignore, needle) in partial {
            let mut files = tree.to_vec();
            files.push((".recipeignore", ignore));
            let report = check_recipe_files(&evals_recipe(None, &files));
            assert!(report.valid, "{:?}", report.diagnostics);
            assert_single(&report, "pi.evals_not_ignored", Severity::Warning, needle);
        }

        // Unread .recipeignore: report once rather than guess.
        let mut input = evals_recipe(None, &tree);
        input.files.push(RecipeFile::unread(".recipeignore"));
        let report = check_recipe_files(&input);
        assert!(report.valid, "{:?}", report.diagnostics);
        assert_single(
            &report,
            "pi.evals_recipeignore_unreadable",
            Severity::Warning,
            ".recipeignore content was not provided",
        );
    }

    #[test]
    fn evals_layout_checks_need_a_declaration() {
        // Without pi.evals, only eval files reaching the runtime are reported.
        let input = evals_recipe(
            None,
            &[
                ("evals/harbor/greet/README.md", "# no task.toml\n"),
                ("test/greet.eval.ts", "export {};\n"),
            ],
        );
        let report = check_recipe_files(&input);
        assert!(report.valid, "{:?}", report.diagnostics);
        assert_single(
            &report,
            "pi.evals_not_ignored",
            Severity::Warning,
            "eval path 'evals/harbor' is not excluded by .recipeignore",
        );
    }

    /// A case file with `front` as its front matter.
    fn case_file(front: &str) -> String {
        format!("---\n{front}---\n\n## Situation\nSomething happens.\n")
    }

    fn approved(id: &str) -> String {
        case_file(&format!(
            "id: {id}\ncheck: code\napproved_by: owner@example.com\napproved_at: 2026-11-04\napproved_in: msg_1\n"
        ))
    }

    fn draft(id: &str) -> String {
        case_file(&format!(
            "id: {id}\ncheck: code\napproved_by:\napproved_at:\napproved_in:\n"
        ))
    }

    /// The `pi.evals_case_*` diagnostics as `(code, path, message)`, sorted.
    fn case_diagnostics(report: &Report) -> Vec<(String, String, String)> {
        let mut found: Vec<(String, String, String)> = report
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code.starts_with("pi.evals_case_"))
            .map(|diagnostic| {
                // Only an unapproved case warns; a broken link or case file fails.
                let severity = if diagnostic.code == "pi.evals_case_unapproved" {
                    Severity::Warning
                } else {
                    Severity::Error
                };
                assert_eq!(diagnostic.severity, severity, "{diagnostic:?}");
                (
                    diagnostic.code.clone(),
                    diagnostic.path.clone(),
                    diagnostic.message.clone(),
                )
            })
            .collect();
        found.sort();
        found
    }

    fn checked_cases(evals: JsonValue, extra: &[(&str, &str)]) -> Report {
        let mut files = vec![(".recipeignore", "evals/\nfakes/\n")];
        files.extend_from_slice(extra);
        check_recipe_files(&evals_recipe(Some(evals), &files))
    }

    /// A Recipe whose case layout passes the check, warnings allowed.
    fn cases_report(evals: JsonValue, extra: &[(&str, &str)]) -> Report {
        let report = checked_cases(evals, extra);
        assert!(report.valid, "{:?}", report.diagnostics);
        report
    }

    /// A Recipe whose case layout fails the check, on case rules only.
    fn failing_cases_report(evals: JsonValue, extra: &[(&str, &str)]) -> Report {
        let report = checked_cases(evals, extra);
        assert!(!report.valid, "{:?}", report.diagnostics);
        for diagnostic in &report.diagnostics {
            if diagnostic.severity == Severity::Error {
                assert!(
                    diagnostic.code.starts_with("pi.evals_case_")
                        && diagnostic.code != "pi.evals_case_unapproved",
                    "{diagnostic:?}"
                );
            }
        }
        report
    }

    #[test]
    fn evals_case_linked_layout_is_clean() {
        let c1 = approved("C1");
        let c2 = approved("C2");
        let c3 = approved("C3");
        let report = cases_report(
            json!({}),
            &[
                (
                    "evals/vitest/greet.eval.jsonl",
                    "{\"schema_version\":3,\"case\":\"C1\",\"name\":\"greets\"}\n\n{\"schema_version\":3,\"case\":\"C2\"}\n",
                ),
                ("evals/vitest/greet.eval.ts", "export {};\n"),
                // One implementation per case: C3 runs on Harbor only.
                ("evals/harbor/C3/task.toml", HARBOR_TASK_TOML),
                ("evals/cases/C1.md", &c1),
                ("evals/cases/C3.md", &c3),
                ("evals/cases/C2.md", &c2),
                // A synthetic input beside the case files is not a case.
                ("evals/cases/inputs/brief.txt", "brief\n"),
                ("fakes/hello-mcp/server.ts", "export {};\n"),
            ],
        );
        // Case files are no stray eval content, and nothing else fires.
        assert!(
            evals_diagnostics(&report).is_empty(),
            "{:?}",
            report.diagnostics
        );
    }

    #[test]
    fn evals_case_unknown_fails() {
        let c1 = approved("C1");
        let report = failing_cases_report(
            json!({}),
            &[
                (
                    "evals/vitest/greet.eval.jsonl",
                    "{\"case\":\"C1\"}\n{\"case\":\"C9\"}\n",
                ),
                ("evals/harbor/greet/task.toml", HARBOR_TASK_TOML),
                (
                    "evals/harbor/renamed/task.toml",
                    "[metadata]\ncase = \"C7\"\ncontract = 1\n\n[verifier]\ntimeout_sec = 1\n",
                ),
                ("evals/cases/C1.md", &c1),
            ],
        );
        assert_eq!(
            case_diagnostics(&report),
            [
                (
                    "pi.evals_case_unknown".into(),
                    "evals/harbor/greet".into(),
                    "Harbor task 'evals/harbor/greet' (by its folder name) names case 'greet', which has no evals/cases/greet.md".into(),
                ),
                (
                    "pi.evals_case_unknown".into(),
                    "evals/harbor/renamed".into(),
                    "Harbor task 'evals/harbor/renamed' ([metadata] case) names case 'C7', which has no evals/cases/C7.md".into(),
                ),
                (
                    "pi.evals_case_unknown".into(),
                    "evals/vitest/greet.eval.jsonl".into(),
                    "row 2 of 'evals/vitest/greet.eval.jsonl' names case 'C9', which has no evals/cases/C9.md".into(),
                ),
            ]
        );
        let row = report
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.path == "evals/vitest/greet.eval.jsonl")
            .unwrap();
        assert_eq!(row.span, Some(Span { line: 2, column: 1 }));
    }

    #[test]
    fn evals_case_harbor_folder_name_fallback() {
        let c3 = approved("C3");
        let greet = approved("greet");
        let report = cases_report(
            json!({}),
            &[
                // No [metadata] case: the folder name is the case id.
                ("evals/harbor/greet/task.toml", HARBOR_TASK_TOML),
                // [metadata] case wins over the folder name, in either form.
                (
                    "evals/harbor/hello-mcp/task.toml",
                    "version = \"1.0\"\n\n[metadata]\n# the owner's case\ncase = 'C3' # literal\n\n[verifier]\ntimeout_sec = 1\n",
                ),
                ("evals/cases/C3.md", &c3),
                ("evals/cases/greet.md", &greet),
            ],
        );
        assert!(
            case_diagnostics(&report).is_empty(),
            "{:?}",
            report.diagnostics
        );
        assert_eq!(
            toml_metadata_case("metadata.case = \"C4\"\n").as_deref(),
            Some("C4")
        );
        assert_eq!(toml_metadata_case("[other]\ncase = \"C4\"\n"), None);
        assert_eq!(
            toml_metadata_case("[metadata]\ncase = \"a\\\"b\"\n").as_deref(),
            Some("a\"b")
        );
    }

    #[test]
    fn evals_case_duplicate_fails() {
        let c1 = approved("C1");
        let report = failing_cases_report(
            json!({ "suites": [
                { "type": "vitest", "path": "evals/vitest" },
                { "type": "vitest", "path": "evals/vitest-slow" },
                { "type": "harbor", "path": "evals/harbor" }
            ] }),
            &[
                ("evals/vitest/a.eval.jsonl", "{\"case\":\"C1\"}\n"),
                ("evals/vitest-slow/b.eval.jsonl", "{\"case\":\"C1\"}\n"),
                ("evals/harbor/C1/task.toml", HARBOR_TASK_TOML),
                (
                    "evals/harbor/c1-again/task.toml",
                    "[metadata]\ncase = \"C1\"\n[verifier]\n",
                ),
                ("evals/cases/C1.md", &c1),
            ],
        );
        assert_eq!(
            case_diagnostics(&report),
            [
                (
                    "pi.evals_case_duplicate".into(),
                    "evals/harbor/C1".into(),
                    "case 'C1' has a second implementation: Harbor task 'evals/harbor/C1' (by its folder name) repeats row 1 of 'evals/vitest/a.eval.jsonl'".into(),
                ),
                (
                    "pi.evals_case_duplicate".into(),
                    "evals/harbor/c1-again".into(),
                    "case 'C1' has a second implementation: Harbor task 'evals/harbor/c1-again' ([metadata] case) repeats row 1 of 'evals/vitest/a.eval.jsonl'".into(),
                ),
                (
                    "pi.evals_case_duplicate".into(),
                    "evals/vitest-slow/b.eval.jsonl".into(),
                    "case 'C1' has a second implementation: row 1 of 'evals/vitest-slow/b.eval.jsonl' repeats row 1 of 'evals/vitest/a.eval.jsonl'".into(),
                ),
            ]
        );
    }

    #[test]
    fn evals_case_on_both_runners_fails() {
        let c1 = approved("C1");
        let report = failing_cases_report(
            json!({}),
            &[
                ("evals/vitest/greet.eval.jsonl", "{\"case\":\"C1\"}\n"),
                ("evals/harbor/C1/task.toml", HARBOR_TASK_TOML),
                ("evals/cases/C1.md", &c1),
            ],
        );
        assert_eq!(
            case_diagnostics(&report),
            [(
                "pi.evals_case_duplicate".into(),
                "evals/harbor/C1".into(),
                "case 'C1' has a second implementation: Harbor task 'evals/harbor/C1' (by its folder name) repeats row 1 of 'evals/vitest/greet.eval.jsonl'".into(),
            )]
        );
        let duplicate = report
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == "pi.evals_case_duplicate")
            .unwrap();
        assert!(duplicate
            .help
            .as_deref()
            .is_some_and(|help| help.contains("keep one and delete the other")));
    }

    #[test]
    fn evals_case_nested_suites_read_each_row_once() {
        let c1 = approved("C1");
        let report = failing_cases_report(
            json!({ "suites": [
                { "type": "vitest", "path": "evals/vitest" },
                { "type": "vitest", "path": "evals/vitest/slow" }
            ] }),
            &[
                ("evals/vitest/slow/a.eval.jsonl", "{\"case\":\"C1\"}\n{}\n"),
                ("evals/cases/C1.md", &c1),
            ],
        );
        assert_eq!(
            case_diagnostics(&report),
            [(
                "pi.evals_case_row_missing_id".into(),
                "evals/vitest/slow/a.eval.jsonl".into(),
                "row 2 of 'evals/vitest/slow/a.eval.jsonl' has no case".into(),
            )]
        );
    }

    #[test]
    fn evals_case_unapproved_warns() {
        let c1 = draft("C1");
        let c2 = draft("C2");
        // Partly approved still counts as not approved.
        let c3 = case_file("id: C3\ncheck: code\napproved_by: owner\n");
        let report = cases_report(
            json!({}),
            &[
                (
                    "evals/vitest/a.eval.jsonl",
                    "{\"case\":\"C1\"}\n{\"case\":\"C3\"}\n",
                ),
                ("evals/cases/C1.md", &c1),
                // A draft without an implementation is just a draft.
                ("evals/cases/C2.md", &c2),
                ("evals/cases/C3.md", &c3),
            ],
        );
        assert_eq!(
            case_diagnostics(&report),
            [
                (
                    "pi.evals_case_unapproved".into(),
                    "evals/cases/C1.md".into(),
                    "case 'C1' has an implementation but is not approved: approved_by, approved_at, approved_in empty".into(),
                ),
                (
                    "pi.evals_case_unapproved".into(),
                    "evals/cases/C3.md".into(),
                    "case 'C3' has an implementation but is not approved: approved_at, approved_in empty".into(),
                ),
            ]
        );
    }

    #[test]
    fn evals_case_approved_hash_unapproves_an_edited_case() {
        let body = "\n## Situation\nSomething happens.\n";
        let hash = spec::case_approval_hash(body);
        let with_hash = |id: &str, hash: &str| {
            format!(
                "---\nid: {id}\ncheck: code\napproved_by: owner@example.com\n\
                 approved_at: 2026-11-04\napproved_in: msg_1\napproved_hash: {hash}\n---\n"
            )
        };
        // The body as approved, with CRLF and trailing whitespace, and a
        // front matter edited after approval: still approved.
        let matching = format!(
            "{}\r\n## Situation   \r\nSomething happens.\r\n\r\n",
            with_hash("C1", &hash)
                .replace("check: code\n", "check: code\ntitle: Edited later\n")
                .replace('\n', "\r\n")
        );
        // The body changed after approval.
        let edited = format!(
            "{}\n## Situation\nSomething else happens.\n",
            with_hash("C2", &hash)
        );
        // Approved before approved_hash existed.
        let no_hash = approved("C3");
        let malformed = format!("{}{body}", with_hash("C4", "sha256:abc"));
        let report = failing_cases_report(
            json!({}),
            &[
                (
                    "evals/vitest/a.eval.jsonl",
                    "{\"case\":\"C1\"}\n{\"case\":\"C2\"}\n{\"case\":\"C3\"}\n{\"case\":\"C4\"}\n",
                ),
                ("evals/cases/C1.md", &matching),
                ("evals/cases/C2.md", &edited),
                ("evals/cases/C3.md", &no_hash),
                ("evals/cases/C4.md", &malformed),
            ],
        );
        assert_eq!(
            case_diagnostics(&report),
            [
                (
                    "pi.evals_case_invalid".into(),
                    "evals/cases/C4.md".into(),
                    "case file 'evals/cases/C4.md' has approved_hash 'sha256:abc', which is not sha256:<64 hex digits>".into(),
                ),
                (
                    "pi.evals_case_unapproved".into(),
                    "evals/cases/C2.md".into(),
                    "case 'C2' has an implementation but changed since it was approved: its body no longer matches approved_hash".into(),
                ),
                (
                    "pi.evals_case_unapproved".into(),
                    "evals/cases/C4.md".into(),
                    "case 'C4' has an implementation but changed since it was approved: its body no longer matches approved_hash".into(),
                ),
            ]
        );
        let help = report
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.path == "evals/cases/C2.md")
            .and_then(|diagnostic| diagnostic.help.as_deref());
        assert_eq!(
            help,
            Some("have the owner review the case and approve it again: introspection eval approve C2")
        );
    }

    #[test]
    fn evals_case_row_missing_id_fails() {
        let c1 = approved("C1");
        let report = failing_cases_report(
            json!({}),
            &[
                (
                    "evals/vitest/a.eval.jsonl",
                    // Blank lines and non-object lines are left to the runner.
                    "{\"case\":\"C1\"}\n{\"schema_version\":2,\"name\":\"old row\"}\n\nnot json\n{\"case\":\"\"}\n",
                ),
                // Only .eval.jsonl files hold rows.
                ("evals/vitest/fixtures/data.jsonl", "{\"input\":\"hi\"}\n"),
                ("evals/cases/C1.md", &c1),
            ],
        );
        assert_eq!(
            case_diagnostics(&report),
            [
                (
                    "pi.evals_case_row_missing_id".into(),
                    "evals/vitest/a.eval.jsonl".into(),
                    "row 2 of 'evals/vitest/a.eval.jsonl' has no case".into(),
                ),
                (
                    "pi.evals_case_row_missing_id".into(),
                    "evals/vitest/a.eval.jsonl".into(),
                    "row 5 of 'evals/vitest/a.eval.jsonl' has no case".into(),
                ),
            ]
        );
        let lines: Vec<usize> = report
            .diagnostics
            .iter()
            .filter_map(|diagnostic| diagnostic.span.map(|span| span.line))
            .collect();
        assert_eq!(lines, [2, 5]);
    }

    const ONLINE_JUDGE: &str =
        "name: helpful\ninstructions: Did the assistant answer correctly?\nllm:\n  model: gpt-5\n";
    const MISSION_JUDGE: &str = "name: booking\ntype: mission\nquestions:\n  requested:\n    instructions: Did the traveller ask for this?\n";

    fn judge_diagnostics(report: &Report) -> Vec<(String, Option<Span>, String)> {
        let mut found: Vec<(String, Option<Span>, String)> = report
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code == "pi.evals_judge_unknown")
            .map(|diagnostic| {
                assert_eq!(diagnostic.severity, Severity::Warning, "{diagnostic:?}");
                (
                    diagnostic.path.clone(),
                    diagnostic.span,
                    diagnostic.message.clone(),
                )
            })
            .collect();
        found.sort_by(|a, b| (&a.0, a.1.map(|s| s.line)).cmp(&(&b.0, b.1.map(|s| s.line))));
        found
    }

    #[test]
    fn evals_judge_unknown_warns() {
        let report = cases_report(
            json!({}),
            &[
                ("judges/helpful.yaml", ONLINE_JUDGE),
                ("judges/booking.yaml", MISSION_JUDGE),
                (
                    "evals/vitest/judges/tone.yaml",
                    ONLINE_JUDGE.replace("helpful", "tone").as_str(),
                ),
                (
                    "evals/vitest/greet.eval.ts",
                    concat!(
                        "import { recipeJudge } from '@introspection-ai/vitest-evals';\n",
                        "const ok = recipeJudge(\"helpful\");\n",
                        "const typo = recipeJudge('helpfull');\n",
                        "const mission = recipeJudge(`booking`);\n",
                        "const file = recipeJudge(\"./evals/vitest/judges/tone.yaml\");\n",
                        "const gone = recipeJudge(\n  \"evals/vitest/judges/missing.yaml\",\n);\n",
                        "// recipeJudge(\"commented\")\n",
                        "const built = recipeJudge(`${prefix}-judge`);\n",
                        "const variable = recipeJudge(name);\n",
                        "const joined = recipeJudge(\"help\" + \"ful\");\n",
                        "const prefixed = recipeJudge('evals/vitest/judges/' + file);\n",
                        "const subject = recipeJudge(\"helpfull\", (run) => run);\n",
                    ),
                ),
                (
                    "evals/lib/judges.ts",
                    "export const j = () => evals.recipeJudge(\"lib-typo\");\n",
                ),
                ("evals/harbor/greet/task.toml", HARBOR_TASK_TOML),
                (
                    "evals/harbor/greet/tests/test.py",
                    concat!(
                        "from introspection_harbor.verifier import judge_reward\n",
                        "ok = judge_reward(\"helpful\")\n",
                        "typo = judge_reward(name='helpfull')\n",
                        "# judge_reward(\"commented\")\n",
                        "built = judge_reward(f\"{prefix}\")\n",
                        "joined = judge_reward(\"help\" + suffix)\n",
                    ),
                ),
                // A Vitest call in a Harbor task is not a Harbor reference.
                (
                    "evals/harbor/greet/tests/helper.ts",
                    "recipeJudge(\"nope\");\n",
                ),
                ("evals/cases/greet.md", &approved("greet")),
            ],
        );
        let line = |line| Some(Span { line, column: 1 });
        assert_eq!(
            judge_diagnostics(&report),
            [
                (
                    "evals/harbor/greet/tests/test.py".into(),
                    line(3),
                    "'evals/harbor/greet/tests/test.py' calls judge_reward(\"helpfull\"), but judges/ has no online judge named 'helpfull'".into(),
                ),
                (
                    "evals/lib/judges.ts".into(),
                    line(1),
                    "'evals/lib/judges.ts' calls recipeJudge(\"lib-typo\"), but judges/ has no online judge named 'lib-typo'".into(),
                ),
                (
                    "evals/vitest/greet.eval.ts".into(),
                    line(3),
                    "'evals/vitest/greet.eval.ts' calls recipeJudge(\"helpfull\"), but judges/ has no online judge named 'helpfull'".into(),
                ),
                (
                    "evals/vitest/greet.eval.ts".into(),
                    line(4),
                    "'evals/vitest/greet.eval.ts' calls recipeJudge(\"booking\"), but judges/ has no online judge named 'booking'".into(),
                ),
                (
                    "evals/vitest/greet.eval.ts".into(),
                    line(6),
                    "'evals/vitest/greet.eval.ts' calls recipeJudge(\"evals/vitest/judges/missing.yaml\"), but 'evals/vitest/judges/missing.yaml' does not exist".into(),
                ),
                (
                    "evals/vitest/greet.eval.ts".into(),
                    line(14),
                    "'evals/vitest/greet.eval.ts' calls recipeJudge(\"helpfull\"), but judges/ has no online judge named 'helpfull'".into(),
                ),
            ]
        );
    }

    #[test]
    fn evals_judge_unknown_skips_unreadable_judges_and_needs_a_declaration() {
        // A judge file that does not parse could hold the name: no name warning.
        let input = evals_recipe(
            Some(json!({})),
            &[
                (".recipeignore", "evals/\nfakes/\n"),
                ("judges/broken.yaml", "name: [\n"),
                ("evals/vitest/a.eval.ts", "recipeJudge(\"helpful\");\n"),
            ],
        );
        let report = check_recipe_files(&input);
        assert!(!report.valid);
        assert!(
            judge_diagnostics(&report).is_empty(),
            "{:?}",
            report.diagnostics
        );
        // No pi.evals: the rule does not run.
        let input = evals_recipe(
            None,
            &[
                (".recipeignore", "evals/\nfakes/\n"),
                ("evals/vitest/a.eval.ts", "recipeJudge(\"helpful\");\n"),
            ],
        );
        let report = check_recipe_files(&input);
        assert!(
            judge_diagnostics(&report).is_empty(),
            "{:?}",
            report.diagnostics
        );
    }

    #[test]
    fn evals_case_rules_need_a_declaration() {
        // Every case rule would fire here, but no pi.evals means no layout checks.
        let c1 = draft("C1");
        let input = evals_recipe(
            None,
            &[
                (".recipeignore", "evals/\nfakes/\n"),
                (
                    "evals/vitest/a.eval.jsonl",
                    "{\"case\":\"C1\"}\n{\"case\":\"C1\"}\n{}\n",
                ),
                ("evals/harbor/greet/task.toml", HARBOR_TASK_TOML),
                ("evals/cases/C1.md", &c1),
                ("evals/cases/bad.md", "no front matter\n"),
            ],
        );
        let report = check_recipe_files(&input);
        assert!(report.diagnostics.is_empty(), "{:?}", report.diagnostics);
    }

    #[test]
    fn evals_case_file_fields() {
        let valid_issue = case_file(
            "id: C1\ncheck: code\nissue: 0b6f2c1e-5a4d-4c3b-9a8e-7f6d5c4b3a21\nconversation: { id: conv_1, task_id: task_1, turn: 2 }\n",
        );
        let bad_issue = case_file("id: C2\nissue: ISSUE-12\n");
        let wrong_id = case_file("id: C4\n");
        let bad_check = case_file("id: C5\ncheck: maybe\n");
        let report = failing_cases_report(
            json!({}),
            &[
                ("evals/cases/C1.md", &valid_issue),
                ("evals/cases/C2.md", &bad_issue),
                ("evals/cases/C3.md", &wrong_id),
                ("evals/cases/C5.md", &bad_check),
                ("evals/cases/C6.md", "# no front matter\n"),
                // A Harbor task naming the malformed case finds it by file name.
                ("evals/harbor/C6/task.toml", HARBOR_TASK_TOML),
            ],
        );
        let found = case_diagnostics(&report);
        let summary: Vec<(&str, &str)> = found
            .iter()
            .map(|(code, path, _)| (code.as_str(), path.as_str()))
            .collect();
        assert_eq!(
            summary,
            [
                ("pi.evals_case_invalid", "evals/cases/C2.md"),
                ("pi.evals_case_invalid", "evals/cases/C3.md"),
                ("pi.evals_case_invalid", "evals/cases/C5.md"),
                ("pi.evals_case_invalid", "evals/cases/C6.md"),
            ]
        );
        assert!(
            found[0].2.contains("issue 'ISSUE-12', which is not a UUID"),
            "{found:?}"
        );
        assert!(
            found[1]
                .2
                .contains("has id 'C4', but a case's id is its file name, 'C3'"),
            "{found:?}"
        );
        assert!(
            found[2].2.contains("front matter is not a valid case"),
            "{found:?}"
        );
        assert!(found[3].2.contains("has no YAML front matter"), "{found:?}");
        assert!(is_uuid("0B6F2C1E-5A4D-4C3B-9A8E-7F6D5C4B3A21"));
        assert!(!is_uuid("0b6f2c1e5a4d4c3b9a8e7f6d5c4b3a21"));
    }

    #[test]
    fn evals_cases_path_is_configurable() {
        let c1 = approved("C1");
        let report = cases_report(
            json!({ "cases": "evals/owner-cases" }),
            &[
                ("evals/vitest/a.eval.jsonl", "{\"case\":\"C1\"}\n"),
                ("evals/owner-cases/C1.md", &c1),
                // The default folder is not read once the path is named.
                ("evals/cases/C2.md", "not a case\n"),
            ],
        );
        assert!(
            case_diagnostics(&report).is_empty(),
            "{:?}",
            report.diagnostics
        );

        let report = failing_cases_report(
            json!({ "cases": "evals/owner-cases" }),
            &[("evals/vitest/a.eval.jsonl", "{\"case\":\"C9\"}\n")],
        );
        assert!(
            case_diagnostics(&report)[0]
                .2
                .contains("which has no evals/owner-cases/C9.md"),
            "{:?}",
            report.diagnostics
        );
    }

    #[test]
    fn evals_fakes_default_is_the_recipe_root() {
        // Root fakes/ is an eval path for every Recipe, so .recipeignore must
        // exclude it.
        let input = evals_recipe(
            None,
            &[
                (".recipeignore", "evals/\n"),
                ("fakes/hello-mcp/server.ts", "export {};\n"),
            ],
        );
        let report = check_recipe_files(&input);
        assert!(report.valid, "{:?}", report.diagnostics);
        assert_single(
            &report,
            "pi.evals_not_ignored",
            Severity::Warning,
            "eval path 'fakes' is not excluded by .recipeignore",
        );
        assert_eq!(
            evals_diagnostics(&report)[0].help.as_deref(),
            Some("add a 'fakes/' line to .recipeignore so eval-only files never reach a deployed runtime")
        );

        // Fakes still under evals/ need no override: evals/ covers them, and
        // they are not eval-looking content.
        let input = evals_recipe(
            Some(json!({})),
            &[
                (".recipeignore", "evals/\n"),
                ("evals/fakes/hello-mcp/server.ts", "export {};\n"),
                ("evals/fakes/hello-mcp/scenarios/a.json", "{}\n"),
            ],
        );
        let report = check_recipe_files(&input);
        assert!(report.diagnostics.is_empty(), "{:?}", report.diagnostics);
    }

    /// A redlining Recipe's layout: a draft case file per
    /// Harbor task, named by the task's folder, and no `pi.evals`.
    fn redlining_layout(case: fn(&str) -> String) -> Vec<(String, String)> {
        let task = "schema_version = \"1.4\"\n\n[task]\nname = \"introspection-recipes/redlining-ID\"\n\n[verifier]\ntimeout_sec = 1800.0\n\n[verifier.env]\nOPENAI_API_KEY = \"${OPENAI_API_KEY}\"\n";
        let mut files = vec![(
            ".recipeignore".to_owned(),
            "evals/\neval-runs/\neval-artifacts/\ntests/\n".to_owned(),
        )];
        for id in [
            "s1-t1-g01",
            "s1-t3-g01",
            "s2-t2-g01",
            "s3-t1-g01",
            "s3-t3-g05",
        ] {
            files.push((format!("evals/cases/{id}.md"), case(id)));
            files.push((
                format!("evals/harbor/{id}/task.toml"),
                task.replace("ID", id),
            ));
            files.push((
                format!("evals/harbor/{id}/instruction.md"),
                "Redline it.\n".into(),
            ));
            files.push((
                format!("evals/harbor/{id}/tests/test.sh"),
                "exit 0\n".into(),
            ));
            files.push((
                format!("evals/harbor/{id}/environment/Dockerfile"),
                "FROM scratch\n".into(),
            ));
        }
        files.push((
            "evals/lib/grader/redlining_grader/grading.py".into(),
            "\n".into(),
        ));
        files
    }

    #[test]
    fn evals_case_redlining_layout() {
        let check = |evals: Option<JsonValue>, case: fn(&str) -> String| {
            let files = redlining_layout(case);
            let files: Vec<(&str, &str)> = files
                .iter()
                .map(|(path, content)| (path.as_str(), content.as_str()))
                .collect();
            let report = check_recipe_files(&evals_recipe(evals, &files));
            assert!(report.valid, "{:?}", report.diagnostics);
            report
        };
        // As it is on main: no pi.evals, so nothing to report.
        let report = check(None, draft);
        assert!(
            evals_diagnostics(&report).is_empty(),
            "{:?}",
            report.diagnostics
        );

        // Declaring pi.evals links every task to its case; the drafts warn.
        let report = check(Some(json!({})), draft);
        let found = case_diagnostics(&report);
        assert_eq!(found.len(), 5, "{found:?}");
        assert!(found
            .iter()
            .all(|(code, _, _)| code == "pi.evals_case_unapproved"));
        assert_eq!(evals_diagnostics(&report).len(), 5);

        // Approved, it is clean.
        let report = check(Some(json!({})), approved);
        assert!(
            evals_diagnostics(&report).is_empty(),
            "{:?}",
            report.diagnostics
        );
    }

    #[test]
    fn evals_stray_content_warns() {
        let input = evals_recipe(
            Some(json!({})),
            &[
                (".recipeignore", "evals/\n"),
                ("test/greet.eval.ts", "export {};\n"),
                ("tasks/greet/task.toml", HARBOR_TASK_TOML),
                // Not eval-looking: no [verifier] table, or not a suite file.
                ("tools/task.toml", "name = \"tool\"\n"),
                ("src/greet.eval.tsx", "export {};\n"),
            ],
        );
        let report = check_recipe_files(&input);
        assert!(report.valid, "{:?}", report.diagnostics);
        let mut stray: Vec<(&str, &str)> = evals_diagnostics(&report)
            .iter()
            .map(|diagnostic| {
                assert_eq!(diagnostic.code, "pi.evals_stray_content");
                assert_eq!(diagnostic.severity, Severity::Warning);
                (diagnostic.path.as_str(), diagnostic.message.as_str())
            })
            .collect();
        stray.sort_unstable();
        assert_eq!(
            stray,
            [
                (
                    "tasks/greet/task.toml",
                    "'tasks/greet/task.toml' looks like a Harbor task but is outside every eval path"
                ),
                (
                    "test/greet.eval.ts",
                    "'test/greet.eval.ts' looks like a vitest-evals suite but is outside every eval path"
                ),
            ]
        );

        // Declaring the location makes it an eval path.
        let input = evals_recipe(
            Some(json!({ "suites": [
                { "type": "vitest", "path": "test" },
                { "type": "harbor", "path": "tasks" }
            ] })),
            &[
                (".recipeignore", "test/\ntasks/\nevals/\n"),
                ("test/greet.eval.ts", "export {};\n"),
                ("tasks/greet/task.toml", HARBOR_TASK_TOML),
                ("evals/cases/greet.md", APPROVED_CASE),
            ],
        );
        let report = check_recipe_files(&input);
        assert!(report.diagnostics.is_empty(), "{:?}", report.diagnostics);
    }

    #[test]
    fn evals_redlining_layout_has_no_errors() {
        let input = evals_recipe(
            None,
            &[
                (".recipeignore", "evals/\nnode_modules/\n"),
                ("evals/README.md", "# Redlining evals\n"),
                ("evals/harbor/nda-mutual/task.toml", HARBOR_TASK_TOML),
                (
                    "evals/harbor/nda-mutual/instruction.md",
                    "Redline the NDA\n",
                ),
                (
                    "evals/harbor/nda-mutual/environment/Dockerfile",
                    "FROM node:22\n",
                ),
                ("evals/harbor/nda-mutual/tests/test.sh", "exit 0\n"),
                ("evals/harbor/msa-vendor/task.toml", HARBOR_TASK_TOML),
                ("evals/harbor/msa-vendor/tests/rubric.json", "{}\n"),
                (
                    "evals/eval-artifacts/2026-10-01/results.json",
                    "{\"score\": 1}\n",
                ),
                ("evals/eval-artifacts/latest/task.toml", HARBOR_TASK_TOML),
            ],
        );
        let report = check_recipe_files(&input);
        assert!(report.valid, "{:?}", report.diagnostics);
        assert!(
            report
                .diagnostics
                .iter()
                .all(|diagnostic| !diagnostic.severity.is_error()),
            "{:?}",
            report.diagnostics
        );
    }
}

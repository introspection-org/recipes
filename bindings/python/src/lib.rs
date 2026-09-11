use std::collections::BTreeMap;

use introspection_recipe_check::spec::{
    judge_definition_json_schema, parse_judge_definitions, JudgeSource,
};
use introspection_recipe_check::template::{
    parse_template_manifest, render_template, resolve_variables, VariableValue,
};
use introspection_recipe_check::{check_recipe_files, RecipeFiles};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;

/// Validate a serialized in-memory Recipe snapshot and return a serialized report.
#[pyfunction]
fn check_recipe_files_json(py: Python<'_>, snapshot_json: &str) -> PyResult<String> {
    let snapshot: RecipeFiles = serde_json::from_str(snapshot_json)
        .map_err(|error| PyValueError::new_err(format!("invalid recipe snapshot: {error}")))?;
    let report = py.detach(move || check_recipe_files(&snapshot));
    serde_json::to_string(&report)
        .map_err(|error| PyValueError::new_err(format!("failed to encode check report: {error}")))
}

/// Parse a serialized `template.yaml` into its manifest.
#[pyfunction]
fn parse_template_manifest_json(manifest_yaml: &str) -> PyResult<String> {
    let manifest = parse_template_manifest(manifest_yaml)
        .map_err(|error| PyValueError::new_err(error.to_string()))?;
    serde_json::to_string(&manifest).map_err(|error| {
        PyValueError::new_err(format!("failed to encode template manifest: {error}"))
    })
}

/// Resolve supplied values against a template manifest, filling defaults.
#[pyfunction]
fn resolve_template_variables_json(manifest_yaml: &str, supplied_json: &str) -> PyResult<String> {
    let manifest = parse_template_manifest(manifest_yaml)
        .map_err(|error| PyValueError::new_err(error.to_string()))?;
    let supplied: BTreeMap<String, String> = serde_json::from_str(supplied_json)
        .map_err(|error| PyValueError::new_err(format!("invalid variables: {error}")))?;
    let resolved = resolve_variables(&manifest, &supplied)
        .map_err(|error| PyValueError::new_err(error.to_string()))?;
    serde_json::to_string(&resolved).map_err(|error| {
        PyValueError::new_err(format!("failed to encode resolved variables: {error}"))
    })
}

/// Render a serialized template repository snapshot into a Recipe snapshot.
#[pyfunction]
fn render_template_json(
    py: Python<'_>,
    snapshot_json: &str,
    variables_json: &str,
) -> PyResult<String> {
    let snapshot: RecipeFiles = serde_json::from_str(snapshot_json)
        .map_err(|error| PyValueError::new_err(format!("invalid template snapshot: {error}")))?;
    let variables: BTreeMap<String, VariableValue> = serde_json::from_str(variables_json)
        .map_err(|error| PyValueError::new_err(format!("invalid variables: {error}")))?;
    let rendered = py
        .detach(move || render_template(&snapshot, &variables))
        .map_err(|error| PyValueError::new_err(error.to_string()))?;
    serde_json::to_string(&rendered)
        .map_err(|error| PyValueError::new_err(format!("failed to encode rendered recipe: {error}")))
}

/// Strictly parse serialized judge YAML sources into normalized definitions.
#[pyfunction]
fn parse_judge_definitions_json(py: Python<'_>, sources_json: &str) -> PyResult<String> {
    let sources: Vec<JudgeSource> = serde_json::from_str(sources_json)
        .map_err(|error| PyValueError::new_err(format!("invalid judge sources: {error}")))?;
    let parsed = py
        .detach(move || parse_judge_definitions(&sources))
        .map_err(|error| PyValueError::new_err(error.to_string()))?;
    serde_json::to_string(&parsed)
        .map_err(|error| PyValueError::new_err(format!("failed to encode parsed judges: {error}")))
}

#[pyfunction]
fn judge_definition_schema_json() -> String {
    judge_definition_json_schema()
}

#[pymodule]
fn _native(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add("__version__", env!("CARGO_PKG_VERSION"))?;
    module.add_function(wrap_pyfunction!(check_recipe_files_json, module)?)?;
    module.add_function(wrap_pyfunction!(parse_template_manifest_json, module)?)?;
    module.add_function(wrap_pyfunction!(resolve_template_variables_json, module)?)?;
    module.add_function(wrap_pyfunction!(render_template_json, module)?)?;
    module.add_function(wrap_pyfunction!(parse_judge_definitions_json, module)?)?;
    module.add_function(wrap_pyfunction!(judge_definition_schema_json, module)?)?;
    Ok(())
}

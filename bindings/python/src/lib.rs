use introspection_recipe_check::format::{format_recipe_files, RecipeIdentity};
use introspection_recipe_check::spec::{
    judge_definition_json_schema, parse_judge_definitions, JudgeSource,
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

/// Rewrite a serialized snapshot to a new Recipe identity.
#[pyfunction]
fn format_recipe_files_json(
    py: Python<'_>,
    snapshot_json: &str,
    identity_json: &str,
) -> PyResult<String> {
    let snapshot: RecipeFiles = serde_json::from_str(snapshot_json)
        .map_err(|error| PyValueError::new_err(format!("invalid recipe snapshot: {error}")))?;
    let identity: RecipeIdentity = serde_json::from_str(identity_json)
        .map_err(|error| PyValueError::new_err(format!("invalid recipe identity: {error}")))?;
    let formatted = py
        .detach(move || format_recipe_files(&snapshot, &identity))
        .map_err(|error| PyValueError::new_err(error.to_string()))?;
    serde_json::to_string(&formatted).map_err(|error| {
        PyValueError::new_err(format!("failed to encode formatted recipe: {error}"))
    })
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
    module.add_function(wrap_pyfunction!(format_recipe_files_json, module)?)?;
    module.add_function(wrap_pyfunction!(parse_judge_definitions_json, module)?)?;
    module.add_function(wrap_pyfunction!(judge_definition_schema_json, module)?)?;
    Ok(())
}

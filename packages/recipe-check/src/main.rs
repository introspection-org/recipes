use std::io::Read;
use std::process::ExitCode;

use introspection_recipe_check::{check_recipe_files, RecipeFiles};

fn run_checker() -> Result<ExitCode, String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if !args.is_empty() {
        return Err("introspection-recipe-check does not accept arguments".to_owned());
    }

    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("failed to read recipe snapshot: {error}"))?;
    let files: RecipeFiles = serde_json::from_str(&input)
        .map_err(|error| format!("failed to parse recipe snapshot: {error}"))?;
    let report = check_recipe_files(&files);
    println!(
        "{}",
        serde_json::to_string(&report)
            .map_err(|error| format!("failed to serialize check report: {error}"))?
    );
    Ok(if report.valid {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    })
}

fn main() -> ExitCode {
    match run_checker() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(2)
        }
    }
}

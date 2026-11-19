use std::io::Read;
use std::process::ExitCode;

use introspection_recipe_check::spec::{parse_judge_definitions, JudgeSource};
use introspection_recipe_check::{check_recipe_files, RecipeFiles};

const USAGE: &str = "usage: introspection-recipe-check [judges] < input.json";

fn read_stdin(what: &str) -> Result<String, String> {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("failed to read {what}: {error}"))?;
    Ok(input)
}

/// Check a recipe snapshot (`RecipeFiles`) and print its report.
fn run_checker() -> Result<ExitCode, String> {
    let files: RecipeFiles = serde_json::from_str(&read_stdin("recipe snapshot")?)
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

/// Strictly parse judge sources (`[{ path, content }]`) and print their
/// normalized definitions; an invalid one prints its error and exits 1.
fn run_judges() -> Result<ExitCode, String> {
    let sources: Vec<JudgeSource> = serde_json::from_str(&read_stdin("judge sources")?)
        .map_err(|error| format!("failed to parse judge sources: {error}"))?;
    match parse_judge_definitions(&sources) {
        Ok(parsed) => {
            println!(
                "{}",
                serde_json::to_string(&parsed)
                    .map_err(|error| format!("failed to serialize judges: {error}"))?
            );
            Ok(ExitCode::SUCCESS)
        }
        Err(error) => {
            eprintln!("{error}");
            Ok(ExitCode::from(1))
        }
    }
}

fn main() -> ExitCode {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let result = match args.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        [] => run_checker(),
        ["judges"] => run_judges(),
        _ => Err(USAGE.to_owned()),
    };
    match result {
        Ok(code) => code,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(2)
        }
    }
}

//! Built-in packs, embedded at compile time so the CLI works standalone with
//! no external pack files. At runtime localflow also loads `guard/packs/*.toml`
//! from userData; the built-ins are the shipped defaults.
//!
//! G1 ships `core.git`. `core.filesystem`, `cloud.gcloud`, and `db.postgres`
//! are follow-on plan tasks and get added here as they land.

use crate::pack::{load_pack_str, Pack, PackWarning};

/// `(source_label, toml)` for every embedded pack.
const BUILTIN_SOURCES: &[(&str, &str)] =
    &[("<builtin>core.git", include_str!("../packs/core.git.toml"))];

/// Load and compile the embedded built-in packs (fail-open: a bad built-in is
/// skipped with a warning, never fatal — though built-ins are covered by tests).
pub fn builtin_packs() -> (Vec<Pack>, Vec<PackWarning>) {
    let mut packs = Vec::new();
    let mut warnings = Vec::new();
    for (source, toml) in BUILTIN_SOURCES {
        match load_pack_str(source, toml, &mut warnings) {
            Ok(p) => packs.push(p),
            Err(e) => warnings.push(PackWarning {
                source: source.to_string(),
                message: format!("built-in pack failed to load: {e}"),
            }),
        }
    }
    (packs, warnings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_git_builtin_loads_clean() {
        let (packs, warnings) = builtin_packs();
        assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");
        assert!(packs.iter().any(|p| p.id == "core.git"));
    }
}

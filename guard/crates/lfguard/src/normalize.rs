//! Command normalization.
//!
//! Strips the leading directory from `argv[0]` (so `/usr/bin/git` matches the
//! same rules as `git`) while preserving every argument verbatim — a path
//! *argument* to `rm` is exactly what the guard must judge. Runs of inter-token
//! whitespace collapse to a single space; case is preserved (commands are
//! case-sensitive).

/// Normalize a raw command line for matching.
///
/// - `argv[0]`'s leading directory is stripped (`/usr/bin/git` -> `git`,
///   `./scripts/x.sh` -> `x.sh`). Only the program token is stripped.
/// - Arguments are preserved exactly (their paths are load-bearing).
/// - Inter-token whitespace collapses to a single space; ends are trimmed.
pub fn normalize(cmd: &str) -> String {
    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    // Split off the first whitespace-delimited token (the program) from the
    // rest of the line. We collapse whitespace only *between* tokens.
    let mut tokens = trimmed.split_whitespace();
    let program = tokens.next().unwrap_or("");
    let program = strip_program_dir(program);

    let mut out = String::with_capacity(trimmed.len());
    out.push_str(program);
    for tok in tokens {
        out.push(' ');
        out.push_str(tok);
    }
    out
}

/// Strip a leading directory from the program token only. A token with no
/// path separator is returned unchanged.
fn strip_program_dir(program: &str) -> &str {
    match program.rfind('/') {
        Some(idx) => &program[idx + 1..],
        None => program,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_absolute_program_path() {
        assert_eq!(normalize("/usr/bin/git status"), "git status");
    }

    #[test]
    fn strips_relative_program_path() {
        assert_eq!(normalize("./scripts/deploy.sh --now"), "deploy.sh --now");
    }

    #[test]
    fn preserves_path_arguments() {
        // The path is an *argument*, not the program — it must survive.
        assert_eq!(normalize("rm -rf /var/data"), "rm -rf /var/data");
    }

    #[test]
    fn collapses_inter_token_whitespace() {
        assert_eq!(normalize("rm  -rf   /tmp/x"), "rm -rf /tmp/x");
    }

    #[test]
    fn trims_ends() {
        assert_eq!(normalize("   git   log   "), "git log");
    }

    #[test]
    fn plain_program_unchanged() {
        assert_eq!(normalize("ls -la"), "ls -la");
    }

    #[test]
    fn empty_input() {
        assert_eq!(normalize("   "), "");
    }
}

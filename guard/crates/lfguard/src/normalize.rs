//! Command normalization.
//!
//! Strips the leading directory from `argv[0]` (so `/usr/bin/git` matches the
//! same rules as `git`) while preserving every argument verbatim — a path
//! *argument* to `rm` is exactly what the guard must judge. Runs of inter-token
//! whitespace collapse to a single space; case is preserved (commands are
//! case-sensitive).
//!
//! Two further per-token evasions are undone here rather than in every
//! pack's regex: a token fully wrapped in matching quotes (`rm -rf "/"`) has
//! that one layer of quoting stripped, and a run of leading slashes on a path
//! token (`rm -rf //`) collapses to one — both are the same target as their
//! unquoted / single-slash form and packs should not have to spell out every
//! quoting/slash variant of a catastrophic path.

/// Normalize a raw command line for matching.
///
/// - `argv[0]`'s leading directory is stripped (`/usr/bin/git` -> `git`,
///   `./scripts/x.sh` -> `x.sh`). Only the program token is stripped.
/// - Every token has one layer of fully-wrapping quotes stripped
///   (`"/"` -> `/`, `'/etc'` -> `/etc`) and, if it starts with `/`, a run of
///   leading slashes collapsed to one (`//` -> `/`, `///etc` -> `/etc`).
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
    let program = strip_program_dir(strip_matching_quotes(program));

    let mut out = String::with_capacity(trimmed.len());
    out.push_str(program);
    for tok in tokens {
        out.push(' ');
        out.push_str(&collapse_leading_slashes(strip_matching_quotes(tok)));
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

/// Strip one layer of quotes from a token that is fully wrapped in a matching
/// pair (`'...'` or `"..."`). A token that is a bare quote character, or
/// whose start/end quotes don't match (e.g. an unterminated quote), is left
/// alone — we only undo *complete* quoting, never guess at broken shell
/// syntax.
fn strip_matching_quotes(tok: &str) -> &str {
    let bytes = tok.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'\'' || first == b'"') && first == last {
            return &tok[1..tok.len() - 1];
        }
    }
    tok
}

/// Collapse a run of leading slashes on a token to a single slash
/// (`//`, `///etc` are the same path as `/`, `/etc`). Tokens that don't start
/// with `/` are returned unchanged (as an owned copy, to keep the call site
/// uniform).
fn collapse_leading_slashes(tok: &str) -> String {
    match tok.strip_prefix('/') {
        Some(rest) => format!("/{}", rest.trim_start_matches('/')),
        None => tok.to_string(),
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

    #[test]
    fn strips_matching_quotes_around_a_token() {
        assert_eq!(normalize(r#"rm -rf "/""#), "rm -rf /");
        assert_eq!(normalize("rm -rf '/'"), "rm -rf /");
        assert_eq!(normalize(r#"rm -rf "/etc""#), "rm -rf /etc");
        assert_eq!(normalize("rm -rf '~'"), "rm -rf ~");
    }

    #[test]
    fn leaves_unterminated_or_mismatched_quotes_alone() {
        assert_eq!(normalize(r#"echo "hello"#), "echo \"hello");
        assert_eq!(normalize(r#"echo 'hi"#), "echo 'hi");
    }

    #[test]
    fn collapses_repeated_leading_slashes() {
        assert_eq!(normalize("rm -rf //"), "rm -rf /");
        assert_eq!(normalize("rm -rf ///etc"), "rm -rf /etc");
        assert_eq!(normalize("rm -rf //////"), "rm -rf /");
    }

    #[test]
    fn quote_stripping_and_program_path_stripping_compose() {
        assert_eq!(normalize(r#""/usr/bin/git" status"#), "git status");
    }
}

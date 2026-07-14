//! Transparent-prefix command unwrapping.
//!
//! A handful of commands merely wrap another command without changing its
//! meaning for our purposes: `command rm -rf /`, `env rm -rf /`, `nohup rm
//! -rf /` all execute `rm -rf /` exactly as if the wrapper weren't there.
//! Unlike `sudo` — handled per-pack via an optional `(?:sudo\s+)?` regex
//! prefix baked into every deny pattern, since `sudo` was already accounted
//! for when those rules were written — these wrappers are peeled off
//! structurally, once, before matching: the engine judges the *effective*
//! command's argv, not the wrapper's, so no pack needs to know about them.
//!
//! Handled: `command`, `env` (skipping leading `VAR=val` assignments and
//! flags), `nohup`, `nice` (skipping an optional `-n VALUE` or `-VALUE`
//! niceness flag), `stdbuf`, `ionice` (skipping leading `-`-prefixed flags).
//!
//! Deliberately not exhaustive — a broader class of wrapper commands change
//! or defer execution in ways this module does not attempt to unwrap:
//! `xargs`, `timeout`, `watch`, `time`, `chroot`, `su -c`, `flock`, and
//! similar. See the design doc's "Known limitations".

use crate::lexer::Word;

/// Command names that transparently wrap another command. Matched
/// case-insensitively against each word's text, mirroring the case-fold
/// applied to argv[0] elsewhere in the pipeline (macOS's case-insensitive
/// filesystem means `COMMAND rm -rf /` finds the same binary as `command`).
const TRANSPARENT_PREFIXES: &[&str] = &["command", "env", "nohup", "nice", "stdbuf", "ionice"];

/// Peel any number of transparent wrapper commands off the front of a
/// segment's words, returning the slice starting at the effective command.
/// Each iteration of the outer loop consumes at least the wrapper's own
/// name, so this is bounded by the segment's length and cannot loop
/// unboundedly on adversarial input (no risk to the latency budget).
pub fn unwrap_transparent_prefix(seg: &[Word]) -> &[Word] {
    let mut rest = seg;
    loop {
        let Some(head) = rest.first() else {
            return rest;
        };
        let name = head.text.to_ascii_lowercase();
        if !TRANSPARENT_PREFIXES.contains(&name.as_str()) {
            return rest;
        }
        rest = &rest[1..];
        match name.as_str() {
            "env" => {
                // `env FOO=bar -i rm -rf /` — skip leading assignments and
                // env's own flags to reach the real command.
                while rest
                    .first()
                    .map(|w| is_env_assignment(&w.text) || w.text.starts_with('-'))
                    .unwrap_or(false)
                {
                    rest = &rest[1..];
                }
            }
            "nice" => {
                if let Some(w) = rest.first() {
                    if w.text == "-n" {
                        rest = &rest[1..]; // consume "-n"
                        if !rest.is_empty() {
                            rest = &rest[1..]; // consume its value
                        }
                    } else if is_dash_numeric(&w.text) {
                        rest = &rest[1..]; // consume "-<niceness>"
                    }
                }
            }
            "stdbuf" | "ionice" | "command" => {
                while rest.first().map(|w| w.text.starts_with('-')).unwrap_or(false) {
                    rest = &rest[1..];
                }
            }
            _ => {}
        }
    }
}

/// True if `tok` looks like a `NAME=value` shell-assignment word (`env`'s
/// leading-assignment syntax), not merely any token containing `=`.
fn is_env_assignment(tok: &str) -> bool {
    match tok.find('=') {
        Some(0) | None => false,
        Some(idx) => {
            let name = &tok[..idx];
            name.chars()
                .next()
                .map(|c| c.is_ascii_alphabetic() || c == '_')
                .unwrap_or(false)
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        }
    }
}

/// True for a bare `-<digits>` token, e.g. `nice`'s short-form niceness flag
/// (`nice -10 cmd`).
fn is_dash_numeric(tok: &str) -> bool {
    tok.strip_prefix('-')
        .map(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(text: &str) -> Word {
        Word {
            text: text.to_string(),
            has_substitution: false,
        }
    }

    fn texts(seg: &[Word]) -> Vec<&str> {
        seg.iter().map(|w| w.text.as_str()).collect()
    }

    #[test]
    fn unwraps_bare_command() {
        let seg = vec![w("command"), w("rm"), w("-rf"), w("/")];
        assert_eq!(texts(unwrap_transparent_prefix(&seg)), vec!["rm", "-rf", "/"]);
    }

    #[test]
    fn unwraps_bare_env() {
        let seg = vec![w("env"), w("rm"), w("-rf"), w("/")];
        assert_eq!(texts(unwrap_transparent_prefix(&seg)), vec!["rm", "-rf", "/"]);
    }

    #[test]
    fn unwraps_env_with_leading_assignments() {
        let seg = vec![
            w("env"),
            w("FOO=bar"),
            w("BAZ=1"),
            w("rm"),
            w("-rf"),
            w("/"),
        ];
        assert_eq!(texts(unwrap_transparent_prefix(&seg)), vec!["rm", "-rf", "/"]);
    }

    #[test]
    fn unwraps_nohup_nice_stdbuf_ionice() {
        for prog in ["nohup", "nice", "stdbuf", "ionice"] {
            let seg = vec![w(prog), w("rm"), w("-rf"), w("/")];
            assert_eq!(
                texts(unwrap_transparent_prefix(&seg)),
                vec!["rm", "-rf", "/"],
                "prefix {prog}"
            );
        }
    }

    #[test]
    fn unwraps_nice_with_n_flag() {
        let seg = vec![w("nice"), w("-n"), w("10"), w("rm"), w("-rf"), w("/")];
        assert_eq!(texts(unwrap_transparent_prefix(&seg)), vec!["rm", "-rf", "/"]);
    }

    #[test]
    fn unwraps_nice_with_short_numeric_flag() {
        let seg = vec![w("nice"), w("-10"), w("rm"), w("-rf"), w("/")];
        assert_eq!(texts(unwrap_transparent_prefix(&seg)), vec!["rm", "-rf", "/"]);
    }

    #[test]
    fn unwraps_stacked_wrappers() {
        let seg = vec![w("nohup"), w("env"), w("nice"), w("rm"), w("-rf"), w("/")];
        assert_eq!(texts(unwrap_transparent_prefix(&seg)), vec!["rm", "-rf", "/"]);
    }

    #[test]
    fn unwraps_case_insensitively() {
        let seg = vec![w("COMMAND"), w("RM"), w("-rf"), w("/")];
        assert_eq!(texts(unwrap_transparent_prefix(&seg)), vec!["RM", "-rf", "/"]);
    }

    #[test]
    fn non_wrapper_is_unchanged() {
        let seg = vec![w("git"), w("status")];
        assert_eq!(texts(unwrap_transparent_prefix(&seg)), vec!["git", "status"]);
    }

    #[test]
    fn plain_ls_through_command_and_env_stays_allow_shaped() {
        assert_eq!(
            texts(unwrap_transparent_prefix(&[w("command"), w("ls")])),
            vec!["ls"]
        );
        assert_eq!(
            texts(unwrap_transparent_prefix(&[w("env"), w("ls")])),
            vec!["ls"]
        );
    }
}

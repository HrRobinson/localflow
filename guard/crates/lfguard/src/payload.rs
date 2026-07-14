//! Hook-payload parsing and inline `-c` extraction.
//!
//! `command_from_hook_json` pulls the proposed command out of an agent
//! PreToolUse-shaped JSON payload (Claude Code delivers this on stdin to a
//! `PreToolUse` hook). Unknown shapes and oversize input return `Err` so the
//! caller can fail open.
//!
//! `inline_payloads` handles the common obfuscation shape where a real command
//! is smuggled inside `bash -c '…'` / `sh -c "…"` / `python -c '…'`. v1 uses a
//! trigger-regex, not a shell parser (no AST) — enough to re-judge the inner
//! command without the cost/fragility of parsing shell grammar.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

/// Hard cap on hook-payload size. Anything larger is refused (fail open) rather
/// than parsed — a guard must not become a memory amplifier.
pub const MAX_PAYLOAD_BYTES: usize = 256 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum PayloadError {
    #[error("payload exceeds {MAX_PAYLOAD_BYTES} bytes")]
    TooLarge,
    #[error("payload is not valid JSON: {0}")]
    Json(String),
    #[error("no command found in hook payload")]
    NoCommand,
}

/// Extract the command string from a PreToolUse-shaped hook payload.
///
/// Tolerant of shape: it looks for the Bash tool's `command` under
/// `tool_input`/`toolInput`/`input`/`params`, then falls back to a top-level
/// `command`. Anything it cannot find yields `NoCommand` (caller fails open).
pub fn command_from_hook_json(input: &str, max_bytes: usize) -> Result<String, PayloadError> {
    if input.len() > max_bytes {
        return Err(PayloadError::TooLarge);
    }
    let v: Value = serde_json::from_str(input).map_err(|e| PayloadError::Json(e.to_string()))?;

    for container in ["tool_input", "toolInput", "input", "params"] {
        if let Some(cmd) = v
            .get(container)
            .and_then(|c| c.get("command"))
            .and_then(Value::as_str)
        {
            if !cmd.trim().is_empty() {
                return Ok(cmd.to_string());
            }
        }
    }
    if let Some(cmd) = v.get("command").and_then(Value::as_str) {
        if !cmd.trim().is_empty() {
            return Ok(cmd.to_string());
        }
    }
    Err(PayloadError::NoCommand)
}

fn inline_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // <interp> -c '<payload>'  or  <interp> -c "<payload>"
        // interp: bash, sh, zsh, dash, python, python3, node, ruby, perl.
        Regex::new(r#"(?:bash|sh|zsh|dash|python3?|node|ruby|perl)\s+-c\s+(?:'([^']*)'|"([^"]*)")"#)
            .expect("static inline regex compiles")
    })
}

/// Extract inner payloads from `<interp> -c '…'` wrappers in `normalized`.
/// Returns the inner command strings (possibly several).
pub fn inline_payloads(normalized: &str) -> Vec<String> {
    inline_regex()
        .captures_iter(normalized)
        .filter_map(|c| c.get(1).or_else(|| c.get(2)))
        .map(|m| m.as_str().to_string())
        .filter(|s| !s.trim().is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_claude_pretooluse_bash_command() {
        let json = r#"{
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": { "command": "git reset --hard", "description": "reset" }
        }"#;
        assert_eq!(
            command_from_hook_json(json, MAX_PAYLOAD_BYTES).unwrap(),
            "git reset --hard"
        );
    }

    #[test]
    fn top_level_command_fallback() {
        let json = r#"{ "command": "rm -rf /tmp/x" }"#;
        assert_eq!(
            command_from_hook_json(json, MAX_PAYLOAD_BYTES).unwrap(),
            "rm -rf /tmp/x"
        );
    }

    #[test]
    fn oversize_is_refused() {
        let big = format!(r#"{{"command":"{}"}}"#, "a".repeat(100));
        let err = command_from_hook_json(&big, 20).unwrap_err();
        assert!(matches!(err, PayloadError::TooLarge));
    }

    #[test]
    fn malformed_json_errors() {
        let err = command_from_hook_json("{not json", MAX_PAYLOAD_BYTES).unwrap_err();
        assert!(matches!(err, PayloadError::Json(_)));
    }

    #[test]
    fn no_command_errors() {
        let err = command_from_hook_json(r#"{"tool_name":"Read"}"#, MAX_PAYLOAD_BYTES).unwrap_err();
        assert!(matches!(err, PayloadError::NoCommand));
    }

    #[test]
    fn extracts_single_inline_payload() {
        assert_eq!(
            inline_payloads("bash -c 'rm -rf /'"),
            vec!["rm -rf /".to_string()]
        );
    }

    #[test]
    fn extracts_double_quoted_inline_payload() {
        assert_eq!(
            inline_payloads(r#"python3 -c "git reset --hard""#),
            vec!["git reset --hard".to_string()]
        );
    }

    #[test]
    fn no_inline_payload_when_absent() {
        assert!(inline_payloads("git status").is_empty());
    }
}

//! Top-level command segmentation.
//!
//! Agents routinely chain a benign command with a destructive one:
//! `echo hi && rm -rf /`, `true; rm -rf ~`, `ls | rm -rf /`. Every deny
//! pattern in the packs is `^`-anchored, so without segmentation the engine
//! only ever judges the *first* token of the whole line and every one of
//! those chained deny commands sails through. `split_segments` splits a raw
//! command line on top-level `&&`, `||`, `;`, `|`, and newline separators so
//! the engine can normalize and run the allow-before-deny pipeline on each
//! piece independently — see `engine::Engine::evaluate`. It runs on the *raw*
//! line, before whitespace-collapsing normalization, because normalization
//! folds a real newline separator into a space and would hide it from the
//! splitter.
//!
//! Splitting is quote-aware: a separator character inside a `'...'` or
//! `"..."` region is part of an argument, not a boundary (`git commit -m "a;
//! rm -rf /"` must not be split on the embedded `;`). This is a character
//! scan, not a shell parser — command substitution (`$(...)`, backticks) and
//! here-docs are not specially handled; see the design doc's known
//! limitations.

/// Split `cmd` into top-level segments on `&&`, `||`, `;`, `|`, and newlines.
/// Quoted regions (`'...'` / `"..."`) are opaque to splitting: a separator
/// character inside a quote never splits. Empty segments (from consecutive
/// separators, or a leading/trailing separator) are dropped. An unterminated
/// quote makes the remainder of the line one segment (the conservative,
/// fail-open-safe outcome — it is not a new bypass, since an unsplit segment
/// is judged as a whole and only fails to catch a deny that would otherwise
/// require the split).
pub fn split_segments(cmd: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut chars = cmd.chars().peekable();

    while let Some(c) = chars.next() {
        if in_single {
            current.push(c);
            if c == '\'' {
                in_single = false;
            }
            continue;
        }
        if in_double {
            current.push(c);
            if c == '"' {
                in_double = false;
            }
            continue;
        }
        match c {
            '\'' => {
                in_single = true;
                current.push(c);
            }
            '"' => {
                in_double = true;
                current.push(c);
            }
            '&' if chars.peek() == Some(&'&') => {
                chars.next();
                segments.push(std::mem::take(&mut current));
            }
            '|' if chars.peek() == Some(&'|') => {
                chars.next();
                segments.push(std::mem::take(&mut current));
            }
            '|' | ';' | '\n' => {
                segments.push(std::mem::take(&mut current));
            }
            _ => current.push(c),
        }
    }
    segments.push(current);

    segments
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_on_and_and() {
        assert_eq!(
            split_segments("echo hi && rm -rf /"),
            vec!["echo hi".to_string(), "rm -rf /".to_string()]
        );
    }

    #[test]
    fn splits_on_semicolon() {
        assert_eq!(
            split_segments("true; rm -rf ~"),
            vec!["true".to_string(), "rm -rf ~".to_string()]
        );
    }

    #[test]
    fn splits_on_pipe_but_not_or() {
        assert_eq!(
            split_segments("ls | rm -rf /"),
            vec!["ls".to_string(), "rm -rf /".to_string()]
        );
        assert_eq!(
            split_segments("make || rm -rf /"),
            vec!["make".to_string(), "rm -rf /".to_string()]
        );
    }

    #[test]
    fn splits_on_newline() {
        assert_eq!(
            split_segments("echo hi\nrm -rf /"),
            vec!["echo hi".to_string(), "rm -rf /".to_string()]
        );
    }

    #[test]
    fn does_not_split_inside_single_quotes() {
        assert_eq!(
            split_segments("bash -c 'echo hi; rm -rf /'"),
            vec!["bash -c 'echo hi; rm -rf /'".to_string()]
        );
    }

    #[test]
    fn does_not_split_inside_double_quotes() {
        assert_eq!(
            split_segments(r#"git commit -m "a; rm -rf /""#),
            vec![r#"git commit -m "a; rm -rf /""#.to_string()]
        );
    }

    #[test]
    fn drops_empty_segments_from_consecutive_separators() {
        assert_eq!(
            split_segments("echo hi ;; echo bye"),
            vec!["echo hi".to_string(), "echo bye".to_string()]
        );
    }

    #[test]
    fn single_command_is_one_segment() {
        assert_eq!(
            split_segments("git status"),
            vec!["git status".to_string()]
        );
    }

    #[test]
    fn unterminated_quote_keeps_remainder_as_one_segment() {
        // Conservative fallback: an unterminated quote means we don't know
        // where the argument actually ends, so nothing after it is split.
        assert_eq!(
            split_segments("echo 'unterminated && rm -rf /"),
            vec!["echo 'unterminated && rm -rf /".to_string()]
        );
    }
}

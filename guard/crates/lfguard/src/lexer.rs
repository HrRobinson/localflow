//! A real shell-ish tokenizer.
//!
//! This replaces the previous ad-hoc, regex/character-scan approach (a naive
//! `split_whitespace` "normalizer" plus a separate quote-aware character scan
//! for chaining-operator splitting). Two adversarial review rounds proved that
//! approach bypassable by quoting shapes it did not understand: an escaped
//! quote that does not close a string (`echo "a\""`), and adjacent-string
//! concatenation (`"/e"tc` is one argument, `/etc`). The fix is to tokenize
//! the whole command line **once**, correctly, and have everything downstream
//! (segmentation, argv construction, matching) operate on the resulting
//! tokens instead of raw text.
//!
//! ## What the lexer understands
//!
//! - **Single quotes** `'...'`: everything inside is literal; there is no
//!   escape mechanism inside single quotes (a backslash is just a backslash).
//! - **Double quotes** `"..."`: literal except for the backslash escapes
//!   POSIX defines inside double quotes — `\"`, `\\`, `\$`, `` \` ``. Any other
//!   backslash is left as a literal backslash (the following character is
//!   read normally on the next iteration). Critically, `\"` does **not**
//!   close the string — only a bare, unescaped `"` does.
//! - **Backslash escapes outside quotes**: `\<char>` is a literal `<char>`,
//!   so `\;` and `\&` are word data, never operators.
//! - **Adjacent-string concatenation**: nothing special is required to
//!   implement this — it falls out of the design. A "word" is a run of
//!   pieces (bare chars, single-quoted regions, double-quoted regions,
//!   escapes, substitutions) with no intervening whitespace; each piece
//!   appends its resolved text to the same word buffer, so `"/e"tc` naturally
//!   becomes the one token `/etc`.
//! - **Command substitution** `$(...)` and backticks `` `...` ``, including
//!   when they occur inside a double-quoted region (real shells still expand
//!   `$(...)` inside double quotes): lexed as a single **opaque** token —
//!   the raw source text is kept (never evaluated), the token's
//!   `has_substitution` flag is set, and — this is the point — any `;`,
//!   `&&`, `||`, `|` inside the substitution's parens/backticks is consumed
//!   as part of the opaque region and never seen as a top-level operator.
//! - **Operator splitting**: unquoted, unescaped `&&`, `||`, `;`, `|`, a
//!   lone `&` (background), and newlines end the current segment. A
//!   separator character that is quoted, escaped, or inside a substitution
//!   is word data, not a boundary.
//!
//! ## What it deliberately does not do
//!
//! No shell grammar beyond the above: no variable expansion, no glob
//! expansion, no here-docs, no evaluating what a substitution would actually
//! output. See the design doc's "known limitations" for the honest scope.

/// One resolved argv token (a word): the fully concatenated, quote/escape
/// resolved text, plus whether it contains an opaque command-substitution
/// region (`$(...)` or `` `...` ``) that the guard could not look inside.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Word {
    pub text: String,
    pub has_substitution: bool,
}

/// A single top-level command segment: the argv-order sequence of words
/// between chaining operators (`&&`, `||`, `;`, `|`, `&`, newline).
pub type Segment = Vec<Word>;

/// Split a raw command line into top-level segments of resolved words.
///
/// This is the crate's one entry point for turning raw shell text into
/// structured argv. Segmentation and quote/escape/concatenation resolution
/// happen together in a single pass, so a separator hidden inside a quoted
/// or escaped region can never be mistaken for a real boundary, and a real
/// boundary hidden by unresolved quoting (`a&&rm -rf /`, no whitespace)
/// can never be missed.
pub fn split_segments(cmd: &str) -> Vec<Segment> {
    let mut segments: Vec<Segment> = Vec::new();
    let mut current: Segment = Vec::new();

    for tok in lex(cmd) {
        match tok {
            LexTok::Word(w) => current.push(w),
            LexTok::Operator(_) => {
                if !current.is_empty() {
                    segments.push(std::mem::take(&mut current));
                }
            }
        }
    }
    if !current.is_empty() {
        segments.push(current);
    }
    segments
}

/// A chaining operator that ends a segment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operator {
    AndAnd,
    OrOr,
    Pipe,
    Semi,
    Amp,
    Newline,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum LexTok {
    Word(Word),
    Operator(Operator),
}

/// Tokenize a raw command line into words and operators, in order. Exposed
/// (crate-visible) mainly so unit tests can assert on tokenization directly
/// rather than only through `split_segments`'s grouping.
#[allow(unused_assignments)] // the final flush_word!() sets state that is never read again
fn lex(input: &str) -> Vec<LexTok> {
    let mut toks: Vec<LexTok> = Vec::new();
    let mut chars = input.chars().peekable();

    let mut word_text = String::new();
    let mut word_has_sub = false;
    let mut in_word = false;

    // Flush the in-progress word (if any) as a completed token.
    macro_rules! flush_word {
        () => {
            if in_word {
                toks.push(LexTok::Word(Word {
                    text: std::mem::take(&mut word_text),
                    has_substitution: word_has_sub,
                }));
                in_word = false;
                word_has_sub = false;
            }
        };
    }

    while let Some(c) = chars.next() {
        match c {
            ' ' | '\t' | '\r' => flush_word!(),
            '\n' => {
                flush_word!();
                toks.push(LexTok::Operator(Operator::Newline));
            }
            '&' => {
                if chars.peek() == Some(&'&') {
                    chars.next();
                    flush_word!();
                    toks.push(LexTok::Operator(Operator::AndAnd));
                } else {
                    flush_word!();
                    toks.push(LexTok::Operator(Operator::Amp));
                }
            }
            '|' => {
                if chars.peek() == Some(&'|') {
                    chars.next();
                    flush_word!();
                    toks.push(LexTok::Operator(Operator::OrOr));
                } else {
                    flush_word!();
                    toks.push(LexTok::Operator(Operator::Pipe));
                }
            }
            ';' => {
                flush_word!();
                toks.push(LexTok::Operator(Operator::Semi));
            }
            '\'' => {
                in_word = true;
                scan_single_quoted(&mut chars, &mut word_text);
            }
            '"' => {
                in_word = true;
                scan_double_quoted(&mut chars, &mut word_text, &mut word_has_sub);
            }
            '\\' => {
                in_word = true;
                // Outside quotes, `\<char>` is a literal `<char>` — this is
                // what keeps `\;` and `\&` from being read as operators. A
                // trailing backslash with nothing after it is kept literal.
                match chars.next() {
                    Some(n) => word_text.push(n),
                    None => word_text.push('\\'),
                }
            }
            '$' if chars.peek() == Some(&'(') => {
                chars.next(); // consume '('
                in_word = true;
                word_has_sub = true;
                word_text.push_str("$(");
                word_text.push_str(&scan_paren_balanced(&mut chars));
                word_text.push(')');
            }
            '`' => {
                in_word = true;
                word_has_sub = true;
                word_text.push('`');
                word_text.push_str(&scan_backtick(&mut chars));
                word_text.push('`');
            }
            other => {
                in_word = true;
                word_text.push(other);
            }
        }
    }
    flush_word!();
    toks
}

type Chars<'a> = std::iter::Peekable<std::str::Chars<'a>>;

/// Single-quoted region: everything up to the next `'` is literal, no
/// escapes at all. An unterminated quote (no closing `'` before EOF) is the
/// conservative fallback: whatever was scanned becomes the word's content
/// and there is nothing left to mis-split, since we have consumed the rest
/// of the input.
fn scan_single_quoted(chars: &mut Chars, out: &mut String) {
    for c in chars.by_ref() {
        if c == '\'' {
            return;
        }
        out.push(c);
    }
}

/// Double-quoted region. Literal except for the four POSIX backslash
/// escapes (`\"`, `\\`, `\$`, `` \` ``) and `$(...)` / `` `...` ``
/// substitution, which is still recognized (and expanded by real shells)
/// inside double quotes. A `\"` does **not** close the string — only a bare
/// `"` does. An unterminated quote is the same conservative fallback as
/// above.
fn scan_double_quoted(chars: &mut Chars, out: &mut String, has_sub: &mut bool) {
    while let Some(c) = chars.next() {
        match c {
            '"' => return,
            '\\' => match chars.peek() {
                Some('"') => {
                    out.push('"');
                    chars.next();
                }
                Some('\\') => {
                    out.push('\\');
                    chars.next();
                }
                Some('$') => {
                    out.push('$');
                    chars.next();
                }
                Some('`') => {
                    out.push('`');
                    chars.next();
                }
                // Not one of the four escapable characters: the backslash
                // is literal and the following character (if any) is read
                // normally on the next loop iteration.
                _ => out.push('\\'),
            },
            '$' if chars.peek() == Some(&'(') => {
                chars.next();
                *has_sub = true;
                out.push_str("$(");
                out.push_str(&scan_paren_balanced(chars));
                out.push(')');
            }
            '`' => {
                *has_sub = true;
                out.push('`');
                out.push_str(&scan_backtick(chars));
                out.push('`');
            }
            other => out.push(other),
        }
    }
}

/// Scan a `$(...)` body. The opening `$(` has already been consumed; this
/// consumes up to and including the matching `)` and returns the inner text
/// (delimiters excluded). Never evaluated — just scanned for correct
/// boundaries. Tracks paren depth, and skips over nested quotes so a `)`
/// inside a quoted string within the substitution does not prematurely end
/// it (`$(echo ")")` stays one substitution).
fn scan_paren_balanced(chars: &mut Chars) -> String {
    let mut depth = 1u32;
    let mut out = String::new();
    while let Some(c) = chars.next() {
        match c {
            '(' => {
                depth += 1;
                out.push(c);
            }
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return out;
                }
                out.push(c);
            }
            '\\' => {
                out.push(c);
                if let Some(n) = chars.next() {
                    out.push(n);
                }
            }
            '\'' => {
                out.push(c);
                for n in chars.by_ref() {
                    out.push(n);
                    if n == '\'' {
                        break;
                    }
                }
            }
            '"' => {
                out.push(c);
                loop {
                    match chars.next() {
                        Some('\\') => {
                            out.push('\\');
                            if let Some(n) = chars.next() {
                                out.push(n);
                            }
                        }
                        Some('"') => {
                            out.push('"');
                            break;
                        }
                        Some(n) => out.push(n),
                        None => break,
                    }
                }
            }
            other => out.push(other),
        }
    }
    // Unterminated: return everything scanned (fail-safe fallback).
    out
}

/// Scan a `` `...` `` body. The opening backtick has already been consumed;
/// this consumes up to and including the matching closing backtick and
/// returns the inner text. `\` escapes the next character (so `` \` ``
/// does not close it).
fn scan_backtick(chars: &mut Chars) -> String {
    let mut out = String::new();
    while let Some(c) = chars.next() {
        match c {
            '`' => return out,
            '\\' => {
                out.push(c);
                if let Some(n) = chars.next() {
                    out.push(n);
                }
            }
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(cmd: &str) -> Vec<String> {
        split_segments(cmd)
            .into_iter()
            .flatten()
            .map(|w| w.text)
            .collect()
    }

    fn segs(cmd: &str) -> Vec<Vec<String>> {
        split_segments(cmd)
            .into_iter()
            .map(|seg| seg.into_iter().map(|w| w.text).collect())
            .collect()
    }

    // ---- quoting ------------------------------------------------------

    #[test]
    fn single_quotes_are_fully_literal() {
        assert_eq!(words("echo 'a && b; c'"), vec!["echo", "a && b; c"]);
    }

    #[test]
    fn double_quotes_resolve_backslash_escapes() {
        assert_eq!(words(r#"echo "a\"b""#), vec!["echo", "a\"b"]);
        assert_eq!(words(r#"echo "a\\b""#), vec!["echo", "a\\b"]);
        assert_eq!(words(r#"echo "a\$b""#), vec!["echo", "a$b"]);
        assert_eq!(words(r#"echo "a\`b""#), vec!["echo", "a`b"]);
    }

    #[test]
    fn escaped_double_quote_does_not_close_the_string() {
        // Round-2 Critical #1: `\"` is data, not a terminator. The real
        // closing quote is the *next* bare `"`.
        assert_eq!(words(r#"echo "a\"""#), vec!["echo", "a\""]);
        assert_eq!(
            segs(r#"echo "a\"" ; rm -rf /"#),
            vec![
                vec!["echo".to_string(), "a\"".to_string()],
                vec!["rm".to_string(), "-rf".to_string(), "/".to_string()],
            ]
        );
    }

    #[test]
    fn unrecognized_backslash_escape_in_double_quotes_is_literal() {
        // \n is not one of the four POSIX double-quote escapes, so the
        // backslash and the character both survive.
        assert_eq!(words(r#"echo "a\nb""#), vec!["echo", "a\\nb"]);
    }

    #[test]
    fn backslash_outside_quotes_escapes_operators_as_data() {
        assert_eq!(segs(r"a \; rm -rf /"), vec![vec!["a", ";", "rm", "-rf", "/"]]);
        assert_eq!(segs(r"a \& rm -rf /"), vec![vec!["a", "&", "rm", "-rf", "/"]]);
    }

    // ---- adjacent-string concatenation ---------------------------------

    #[test]
    fn adjacent_strings_concatenate_into_one_argument() {
        assert_eq!(words(r#"rm -rf "/e"tc"#), vec!["rm", "-rf", "/etc"]);
        assert_eq!(words(r#"rm -rf /et"c""#), vec!["rm", "-rf", "/etc"]);
        assert_eq!(words(r#"rm -rf ""/"#), vec!["rm", "-rf", "/"]);
        assert_eq!(words(r#"rm -rf /""#), vec!["rm", "-rf", "/"]);
        assert_eq!(words(r#"rm -rf "/"//"#), vec!["rm", "-rf", "///"]);
    }

    // ---- operator splitting --------------------------------------------

    #[test]
    fn splits_on_and_and_and_or_or_and_semi_and_pipe() {
        assert_eq!(
            segs("echo hi && rm -rf /"),
            vec![vec!["echo", "hi"], vec!["rm", "-rf", "/"]]
        );
        assert_eq!(
            segs("a && b || rm -rf /"),
            vec![vec!["a"], vec!["b"], vec!["rm", "-rf", "/"]]
        );
        assert_eq!(segs("true; rm -rf ~"), vec![vec!["true"], vec!["rm", "-rf", "~"]]);
        assert_eq!(segs("foo | rm -rf /"), vec![vec!["foo"], vec!["rm", "-rf", "/"]]);
    }

    #[test]
    fn splits_with_no_surrounding_whitespace() {
        assert_eq!(segs("a&&rm -rf /"), vec![vec!["a"], vec!["rm", "-rf", "/"]]);
        assert_eq!(segs("a ;rm -rf /"), vec![vec!["a"], vec!["rm", "-rf", "/"]]);
    }

    #[test]
    fn splits_on_newline() {
        assert_eq!(
            segs("a\nrm -rf /"),
            vec![vec!["a"], vec!["rm", "-rf", "/"]]
        );
    }

    #[test]
    fn does_not_split_a_separator_inside_quotes() {
        assert_eq!(segs(r#"echo "a && b""#), vec![vec!["echo", "a && b"]]);
        assert_eq!(segs(r#"echo "a; b""#), vec![vec!["echo", "a; b"]]);
        assert_eq!(segs("echo 'a; b'"), vec![vec!["echo", "a; b"]]);
    }

    #[test]
    fn drops_empty_segments_from_consecutive_separators() {
        assert_eq!(segs("echo hi ;; echo bye"), vec![vec!["echo", "hi"], vec!["echo", "bye"]]);
    }

    #[test]
    fn unterminated_quote_keeps_remainder_as_one_word() {
        assert_eq!(
            segs("echo 'unterminated && rm -rf /"),
            vec![vec!["echo", "unterminated && rm -rf /"]]
        );
    }

    // ---- command substitution ------------------------------------------

    #[test]
    fn dollar_paren_is_opaque_and_flagged() {
        let segments = split_segments("rm -rf $(some-cmd)");
        assert_eq!(segments.len(), 1);
        let seg = &segments[0];
        assert_eq!(seg[2].text, "$(some-cmd)");
        assert!(seg[2].has_substitution);
        assert!(!seg[0].has_substitution);
    }

    #[test]
    fn separators_inside_dollar_paren_do_not_split_the_segment() {
        let segments = segs("echo $(a; b && c) more");
        assert_eq!(segments.len(), 1, "got {segments:?}");
    }

    #[test]
    fn dollar_paren_inside_double_quotes_is_still_opaque() {
        let segments = split_segments(r#"echo "$(date)""#);
        assert_eq!(segments.len(), 1);
        let seg = &segments[0];
        assert_eq!(seg[1].text, "$(date)");
        assert!(seg[1].has_substitution);
    }

    #[test]
    fn backtick_substitution_is_opaque_and_flagged() {
        let segments = split_segments("echo `date`");
        let seg = &segments[0];
        assert_eq!(seg[1].text, "`date`");
        assert!(seg[1].has_substitution);
    }

    #[test]
    fn nested_parens_in_substitution_stay_balanced() {
        let segments = segs("echo $(echo $(date))");
        assert_eq!(segments.len(), 1);
    }
}

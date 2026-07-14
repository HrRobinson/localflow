//! The decision engine: normalize -> pre-filter -> match (allow before deny)
//! -> decide, with an inline `-c` re-entry and a hard latency cap that fails
//! open.

use std::time::{Duration, Instant};

use crate::normalize::normalize;
use crate::pack::Pack;
use crate::payload::inline_payloads;
use crate::prefilter::Prefilter;

/// Default latency budget for a single evaluation. Exceeding it yields
/// `Allow { .. timed_out: true }` — continuity wins over a stalled guard.
pub const DEFAULT_BUDGET: Duration = Duration::from_millis(50);

/// The engine's verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// The command is permitted. `trace` explains why (no pack matched, an
    /// allow rule carved it out, or the guard failed open).
    Allow { trace: AllowTrace },
    /// The command is blocked by a deny rule.
    Deny {
        pack: String,
        pattern: String,
        reason: String,
        /// Set when the match was found inside an inline `-c '…'` payload.
        via_inline: Option<String>,
    },
}

/// Why a command was allowed — surfaced by `explain`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AllowTrace {
    /// No pack's deny rule matched.
    NoMatch,
    /// An allow rule short-circuited a would-be deny.
    AllowRule {
        pack: String,
        pattern: String,
        reason: String,
    },
    /// The guard failed open (budget exceeded); the command was not judged.
    FailedOpenTimeout,
}

impl Decision {
    pub fn is_deny(&self) -> bool {
        matches!(self, Decision::Deny { .. })
    }
}

/// The loaded engine: packs plus a combined pre-filter over all their triggers.
pub struct Engine {
    packs: Vec<Pack>,
    combined: Prefilter,
    budget: Duration,
}

impl Engine {
    /// Build an engine from loaded packs.
    pub fn new(packs: Vec<Pack>) -> Self {
        let triggers: Vec<String> = packs.iter().flat_map(|p| p.triggers.clone()).collect();
        Self {
            combined: Prefilter::new(triggers),
            packs,
            budget: DEFAULT_BUDGET,
        }
    }

    /// Override the latency budget (mainly for tests).
    pub fn with_budget(mut self, budget: Duration) -> Self {
        self.budget = budget;
        self
    }

    /// Number of loaded packs.
    pub fn pack_count(&self) -> usize {
        self.packs.len()
    }

    /// Evaluate a raw command line and return the decision.
    pub fn evaluate(&self, raw_cmd: &str) -> Decision {
        let start = Instant::now();
        let normalized = normalize(raw_cmd);

        // Fast reject: if nothing any pack cares about is present, allow.
        if !self.combined.might_match(&normalized) {
            return Decision::Allow {
                trace: AllowTrace::NoMatch,
            };
        }

        // Judge the outer command.
        match self.judge(&normalized, start) {
            JudgeOutcome::Decided(d) => return d,
            JudgeOutcome::TimedOut => {
                return Decision::Allow {
                    trace: AllowTrace::FailedOpenTimeout,
                }
            }
            JudgeOutcome::Clean => {}
        }

        // Judge any inline `-c '…'` payloads (obfuscation shape). A deny there
        // denies the whole command.
        for inner in inline_payloads(&normalized) {
            if start.elapsed() > self.budget {
                return Decision::Allow {
                    trace: AllowTrace::FailedOpenTimeout,
                };
            }
            let inner_norm = normalize(&inner);
            match self.judge(&inner_norm, start) {
                JudgeOutcome::Decided(Decision::Deny {
                    pack,
                    pattern,
                    reason,
                    ..
                }) => {
                    return Decision::Deny {
                        pack,
                        pattern,
                        reason,
                        via_inline: Some(inner.clone()),
                    }
                }
                JudgeOutcome::Decided(allow) => return allow, // an inline allow-rule wins
                JudgeOutcome::TimedOut => {
                    return Decision::Allow {
                        trace: AllowTrace::FailedOpenTimeout,
                    }
                }
                JudgeOutcome::Clean => {}
            }
        }

        Decision::Allow {
            trace: AllowTrace::NoMatch,
        }
    }

    /// Run allow-before-deny across all packs for one normalized command.
    fn judge(&self, normalized: &str, start: Instant) -> JudgeOutcome {
        for pack in &self.packs {
            if start.elapsed() > self.budget {
                return JudgeOutcome::TimedOut;
            }
            if !pack.prefilter().might_match(normalized) {
                continue;
            }
            // Allow rules first — a match short-circuits to ALLOW.
            for rule in &pack.allow {
                if rule.regex.is_match(normalized) {
                    return JudgeOutcome::Decided(Decision::Allow {
                        trace: AllowTrace::AllowRule {
                            pack: pack.id.clone(),
                            pattern: rule.pattern.clone(),
                            reason: rule.reason.clone(),
                        },
                    });
                }
            }
            // Then deny rules — first match wins.
            for rule in &pack.deny {
                if rule.regex.is_match(normalized) {
                    return JudgeOutcome::Decided(Decision::Deny {
                        pack: pack.id.clone(),
                        pattern: rule.pattern.clone(),
                        reason: rule.reason.clone(),
                        via_inline: None,
                    });
                }
            }
        }
        JudgeOutcome::Clean
    }
}

enum JudgeOutcome {
    Decided(Decision),
    Clean,
    TimedOut,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pack::load_pack_str;

    fn test_engine() -> Engine {
        let toml = r#"
[pack]
id = "test.git"
triggers = ["git"]

[[allow]]
pattern = '^git\s+reset\s+--hard\s+HEAD~\d+\b'
reason = "soft-ish reset by N commits is intentional"

[[deny]]
pattern = '^git\s+reset\s+--hard\b'
reason = "discards uncommitted work"

[[deny]]
pattern = '^git\s+clean\s+-[a-z]*f'
reason = "deletes untracked files"
"#;
        let mut w = Vec::new();
        let pack = load_pack_str("<t>", toml, &mut w).unwrap();
        Engine::new(vec![pack])
    }

    #[test]
    fn deny_reports_pack_pattern_reason() {
        let d = test_engine().evaluate("git reset --hard");
        match d {
            Decision::Deny {
                pack,
                reason,
                via_inline,
                ..
            } => {
                assert_eq!(pack, "test.git");
                assert!(reason.contains("uncommitted"));
                assert!(via_inline.is_none());
            }
            _ => panic!("expected deny, got {d:?}"),
        }
    }

    #[test]
    fn allow_rule_beats_deny() {
        // Matches the allow carve-out AND the broad deny; allow must win.
        let d = test_engine().evaluate("git reset --hard HEAD~2");
        assert!(!d.is_deny());
        assert!(matches!(
            d,
            Decision::Allow {
                trace: AllowTrace::AllowRule { .. }
            }
        ));
    }

    #[test]
    fn safe_command_allowed() {
        let d = test_engine().evaluate("git status");
        assert_eq!(
            d,
            Decision::Allow {
                trace: AllowTrace::NoMatch
            }
        );
    }

    #[test]
    fn prefilter_skips_unrelated_command() {
        let d = test_engine().evaluate("ls -la");
        assert_eq!(
            d,
            Decision::Allow {
                trace: AllowTrace::NoMatch
            }
        );
    }

    #[test]
    fn first_matching_deny_wins() {
        let d = test_engine().evaluate("git clean -fd");
        match d {
            Decision::Deny { reason, .. } => assert!(reason.contains("untracked")),
            _ => panic!("expected deny"),
        }
    }

    #[test]
    fn inline_payload_is_judged() {
        let d = test_engine().evaluate("bash -c 'git reset --hard'");
        match d {
            Decision::Deny {
                via_inline, reason, ..
            } => {
                assert_eq!(via_inline.as_deref(), Some("git reset --hard"));
                assert!(reason.contains("uncommitted"));
            }
            _ => panic!("expected inline deny, got {d:?}"),
        }
    }
}

# Contributing to localflow

Thanks for wanting to help! A few hard rules keep this repo pleasant.

## Commits

- **Conventional Commits are enforced by CI** (commitlint): `feat:`, `fix:`, `docs:`,
  `chore:`, `test:`, `ci:`, `refactor:` — subject line **max 50 characters**,
  imperative mood, explain the _why_ in the body if needed.
- Releases and the CHANGELOG are generated from commit types by release-please,
  so mislabelled commits produce wrong changelogs — please take the prefix seriously.
- Using Claude Code or another AI agent? Install
  [caveman](https://github.com/juliusbrussee/caveman) and use `/caveman-commit`
  to get compliant messages for free. Any tool (or none) is fine — only the
  format is enforced.

## Pull requests

- Keep PRs small and focused — one concern per PR.
- `npm run check` (lint + typecheck + unit tests) must pass locally and in CI.
- New behavior needs a test. Bug fixes need a test that fails without the fix.
- PR titles must also be Conventional Commit formatted (squash merges use them).

## Dev setup

Node ≥ 20. `npm install`, then `npm run dev`. To run the app without a real
Claude session: `LOCALFLOW_CLAUDE_BIN="$PWD/tests/fixtures/fake-claude.sh" npm run dev`.

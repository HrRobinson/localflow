export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [2, 'always', 50]
  },
  // GitHub squash merges append " (#123)" to the PR title. The pr-title CI
  // job has already validated the title's format and the 50-char budget is
  // meant for the hand-written part, so skip linting for headers that fit
  // once that exact suffix is stripped. Hand-written commits never carry
  // the suffix, so local husky checks are unaffected.
  ignores: [
    (message) => {
      const header = message.split('\n')[0]
      const stripped = header.replace(/ \(#\d+\)$/, '')
      return stripped !== header && stripped.length <= 50
    },
    // Dependabot subjects ("chore(deps-dev): bump X from 1.2.3 to 1.2.4")
    // are machine-generated and routinely exceed the 50-char budget. CI
    // already skips dependabot-actored PR runs, but the squash commit lands
    // on main under the merger's identity, so exempt the well-known subject
    // shape here too. Hand-written commits never match it.
    (message) => /^chore\(deps(-dev)?\): bump /.test(message.split('\n')[0])
  ]
}

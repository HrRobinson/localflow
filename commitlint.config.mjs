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
    }
  ]
}

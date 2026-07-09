import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.tsx', 'src/renderer/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules
  },
  {
    // Plain-JS ESM CLI (not covered by the TS-aware recommended config, which
    // is what quiets `no-undef` for Node/DOM globals elsewhere): declare the
    // runtime globals it actually uses instead of disabling checks.
    files: ['openclaw/skills/localflow/bin/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', fetch: 'readonly' }
    }
  }
)

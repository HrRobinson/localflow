import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    // `.claude/` holds gitignored agent worktrees — each a full repo checkout
    // with its own tsconfig, which otherwise makes typescript-eslint throw
    // "multiple candidate TSConfigRootDirs". eslint's flat config does not read
    // .gitignore, so it must be ignored explicitly here.
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      '.claude/**'
    ]
  },
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
    files: ['openclaw/skills/saiife/bin/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', fetch: 'readonly' }
    }
  }
)

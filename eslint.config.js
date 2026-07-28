import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // fixtures/repos holds bench fixture repos (synthetic and vendored real
    // third-party code, e.g. chalk); they are test data measured by the
    // bench harness, not our own source, and vendored files carry their
    // upstream project's own lint conventions (eslint-disable comments for
    // plugin rules we do not install). .claude holds generated launchers and
    // session worktrees (full checkouts, fixtures included) that the
    // pre-push lint must not descend into.
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'fixtures/repos/**', '.claude/**', '.dcp/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
);

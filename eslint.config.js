import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: false }],
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' },
  },
  // The flat config and the container health check are plain JS, outside the TypeScript program:
  // the health check has to run inside a distroless image, which carries no build step.
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    // The health check runs on Node inside the image, and the release scripts run on
    // Node in CI, so both have Node's globals — including `console`, which is the
    // only way a build script talks to anyone.
    languageOptions: {
      globals: {
        process: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
        console: 'readonly',
        URL: 'readonly',
      },
    },
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' },
  },
);

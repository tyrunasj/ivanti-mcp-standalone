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
  // The flat config itself is plain JS and outside the TypeScript program.
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' },
  },
);

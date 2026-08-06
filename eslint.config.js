import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'eslint.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['src/surface/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          '@larksuiteoapi/node-sdk',
          '@larksuiteoapi/node-sdk/**',
          '**/qm/client.*',
          '**/feishu/client.*',
          '**/qm/**',
          '**/feishu/**',
        ],
      }],
    },
  },
  {
    files: ['src/qm/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['**/feishu/**', '@yc-software/qm/**'] }],
    },
  },
  {
    files: ['src/feishu/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['**/qm/**', '@yc-software/qm/**'] }],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-misused-spread': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-invalid-void-type': 'off',
    },
  },
);

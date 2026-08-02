import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
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
    files: ['src/surface/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          '@larksuiteoapi/node-sdk',
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
    },
  },
);

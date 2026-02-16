import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'firebase/functions/**', 'dist-server/**'],
  },
  js.configs.recommended,
  // Server: TypeScript with Node globals
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: ['server/**/*.ts'],
  })),
  {
    files: ['server/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      'no-unused-vars': 'off',
    },
  },
  // Admin and test files have intentionally unused functions
  {
    files: ['server/admin.ts', 'server/test.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  // Client: Vue + TypeScript
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: ['client/**/*.{js,ts,vue}'],
  })),
  ...pluginVue.configs['flat/essential'].map(config => ({
    ...config,
    files: config.files ? ['client/**/*.vue'] : ['client/**/*.{js,ts,vue}'],
  })),
  {
    files: ['client/**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    files: ['client/**/*.{js,ts,vue}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
    },
    rules: {
      'no-debugger': process.env.NODE_ENV === 'production' ? 'error' : 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-unused-vars': 'off',
    },
  },
);

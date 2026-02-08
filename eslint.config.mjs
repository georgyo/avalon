import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import { fixupPluginRules } from '@eslint/compat';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'firebase/functions/**'],
  },
  js.configs.recommended,
  // Server: plain JS with Node globals
  {
    files: ['server/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
    },
  },
  // Admin and test files have intentionally unused functions
  {
    files: ['server/admin.js', 'server/test.js'],
    rules: {
      'no-unused-vars': 'off',
      'no-undef': 'off',
    },
  },
  // Client: Vue + TypeScript
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: ['client/**/*.{js,ts,vue}'],
  })),
  {
    files: ['client/**/*.{js,ts,vue}'],
    plugins: {
      vue: fixupPluginRules(pluginVue),
    },
    rules: {
      ...pluginVue.configs['flat/essential'].reduce((acc, config) => {
        return { ...acc, ...config.rules };
      }, {}),
    },
  },
  {
    files: ['client/**/*.vue'],
    languageOptions: {
      parser: pluginVue.configs['flat/essential'].find(c => c.languageOptions?.parser)?.languageOptions.parser,
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
      'vue/comment-directive': 'off',
      'vue/multi-word-component-names': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-unused-vars': 'off',
    },
  },
);

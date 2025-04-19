import pluginVue from 'eslint-plugin-vue';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  // Base: support modern ECMAScript modules
  {
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' }
    }
  },
  // Vue recommended flat config (includes parser setup for .vue files)
  ...pluginVue.configs['flat/recommended'],
  // Overrides: disable prop-type, default-prop, emits checks since we use TS for typing
  {
    files: [
      '*.vue', '**/*.vue',
      '*.js', '**/*.js',
      '*.mjs', '**/*.mjs',
      '*.cjs', '**/*.cjs',
      '*.ts', '**/*.ts'
    ],
    rules: {
      'vue/require-prop-types': 'off',
      'vue/require-default-prop': 'off',
      'vue/require-explicit-emits': 'off'
    }
  },
  // TypeScript files
  {
    files: ['*.ts', '**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        // Use current working directory for tsconfig
        tsconfigRootDir: process.cwd(),
        extraFileExtensions: ['.vue']
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin
    },
    rules: {}
  }
];

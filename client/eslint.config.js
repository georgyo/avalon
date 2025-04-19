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
  // Overrides: disable prop-type, default-prop, emits and template style rules for JS and Vue files
  {
    files: [
      '*.vue', '**/*.vue',
      '*.js', '**/*.js',
      '*.mjs', '**/*.mjs',
      '*.cjs', '**/*.cjs',
      '*.ts', '**/*.ts'
    ],
    rules: {}
  },
  // TypeScript files
  {
    files: ['*.ts', '**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
        extraFileExtensions: ['.vue']
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin
    },
    rules: {}
  }
];

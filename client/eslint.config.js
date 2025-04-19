import pluginVue from 'eslint-plugin-vue';

export default [
  // Base: support modern ECMAScript modules
  {
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' }
    }
  },
  // Vue recommended flat config (includes parser setup for .vue files)
  ...pluginVue.configs['flat/recommended'],
  // Overrides: disable prop-type, default-prop, emits and template style rules
  {
    files: ['*.vue', '**/*.vue',
            '*.js', '**/*.js',
            '*.mjs', '**/*.mjs',
            '*.cjs', '**/*.cjs',
            '*.ts', '**/*.ts'
           ],
    rules: {
    }
  }
];

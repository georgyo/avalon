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
    files: ['*.vue', '**/*.vue'],
    rules: {
      'vue/require-prop-types': 'off',
      'vue/require-default-prop': 'off',
      'vue/require-explicit-emits': 'off',
      // Template style rules disabled
      'vue/html-self-closing': 'off',
      'vue/html-quotes': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/attributes-order': 'off',
      'vue/v-bind-style': 'off',
      'vue/v-slot-style': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/first-attribute-linebreak': 'off',
      'vue/no-multi-spaces': 'off'
    }
  }
];
import js from '@eslint/js';
import pluginPromise from 'eslint-plugin-promise';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2017,
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      promise: pluginPromise,
    },
    rules: {
      'no-console': 'off',
      'no-regex-spaces': 'off',
      'no-debugger': 'off',
      'no-unused-vars': 'off',
      'no-mixed-spaces-and-tabs': 'off',
      'no-undef': 'off',
      'no-template-curly-in-string': 'warn',
      'consistent-return': 'warn',
      'array-callback-return': 'warn',
      'eqeqeq': 'error',
      'no-alert': 'error',
      'no-caller': 'error',
      'no-eq-null': 'error',
      'no-eval': 'error',
      'no-extend-native': 'warn',
      'no-extra-bind': 'warn',
      'no-extra-label': 'warn',
      'no-implicit-coercion': 'warn',
      'no-loop-func': 'warn',
      'no-new-func': 'error',
      'no-new-wrappers': 'warn',
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',
      'for-direction': 'error',
      'getter-return': 'error',
      'no-await-in-loop': 'error',
      'no-compare-neg-zero': 'error',
      'no-shadow-restricted-names': 'error',
      'prefer-arrow-callback': 'warn',
      'promise/always-return': 'error',
      'promise/catch-or-return': 'error',
      'promise/no-nesting': 'warn',
    },
  },
];

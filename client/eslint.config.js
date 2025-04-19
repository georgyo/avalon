import pluginVue from 'eslint-plugin-vue';

export default [
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module'
      }
    }
  },
  ...pluginVue.configs['flat/recommended']
];
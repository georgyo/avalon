import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';

// docs/p2p-protocol.md §11.1: protocol code must be deterministic. In
// common/crypto and common/protocol (except driver.ts, which receives `now()`
// by injection, and except tests and benchmarks) there is no wall clock, no
// Math.random, no locale-dependent API and no floating point.
const DETERMINISM_MSG = 'Banned in protocol code (docs/p2p-protocol.md §11.1): it must be deterministic.';
const FLOAT_MATH = [
  'random', 'sqrt', 'cbrt', 'pow', 'exp', 'expm1', 'log', 'log2', 'log10', 'log1p', 'hypot', 'fround',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
];
const LOCALE_METHODS = [
  'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString', 'toLocaleUpperCase', 'toLocaleLowerCase', 'localeCompare',
];
const FLOAT_METHODS = ['toFixed', 'toPrecision', 'toExponential'];
const determinismRules = {
  'no-restricted-globals': ['error',
    ...['Date', 'Intl', 'parseFloat', 'Float32Array', 'Float64Array', 'performance'].map((name) => ({ name, message: DETERMINISM_MSG })),
  ],
  'no-restricted-properties': ['error',
    ...FLOAT_MATH.map((property) => ({ object: 'Math', property, message: DETERMINISM_MSG })),
    { object: 'Number', property: 'parseFloat', message: DETERMINISM_MSG },
    { object: 'Number', property: 'EPSILON', message: DETERMINISM_MSG },
    { object: 'globalThis', property: 'Date', message: DETERMINISM_MSG },
    { object: 'globalThis', property: 'Intl', message: DETERMINISM_MSG },
  ],
  'no-restricted-syntax': ['error',
    {
      // Non-integer number literals (1.5, .5, 1e-3, 1e3). Hex, octal, binary and bigint literals are fine.
      selector: 'Literal[raw=/^(?!0[xXoObB])[0-9_]*\\.[0-9]|^(?!0[xXoObB])[0-9_.]*[eE]/]',
      message: `Floating-point literal. ${DETERMINISM_MSG}`,
    },
    {
      selector: `CallExpression[callee.property.name=/^(${[...LOCALE_METHODS, ...FLOAT_METHODS].join('|')})$/]`,
      message: `Locale-dependent or floating-point formatting. ${DETERMINISM_MSG}`,
    },
  ],
};

const unusedVars = ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'dist-server/**', 'server/dist/**', '.yarn/**', 'result/**'],
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
      '@typescript-eslint/no-unused-vars': unusedVars,
      'no-unused-vars': 'off',
    },
  },
  // Common: isomorphic TypeScript (browser, worker and node)
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: ['common/**/*.ts'],
  })),
  {
    files: ['common/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.es2022,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': unusedVars,
      'no-unused-vars': 'off',
    },
  },
  {
    files: ['common/crypto/**/*.ts', 'common/protocol/**/*.ts'],
    ignores: ['common/protocol/driver.ts', '**/*.test.ts', 'common/crypto/bench.ts'],
    rules: determinismRules,
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
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-unused-vars': 'off',
    },
  },
  // Node scripts: e2e tests (Playwright; page.evaluate bodies run in the browser) and configs
  {
    files: ['tests/**/*.mjs', '*.mjs', '*.js', 'client/*.js', 'client/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.es2022,
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
);

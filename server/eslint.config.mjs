import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  // Base: support modern ECMAScript modules
  {
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' }
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
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin
    },
    rules: {}
  }
];

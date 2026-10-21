import js from '@eslint/js';
import globals from 'globals';
import jest from 'eslint-plugin-jest';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['node_modules/', 'logs/', 'coverage/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    rules: {
      'no-console': 'warn',
      'no-unused-vars': ['error', { argsIgnorePattern: '^(_|req|res|next)$' }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    files: ['**/*.cjs', '.sequelizerc', 'src/migrations/**/*.js', 'src/seeders/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
  {
    files: ['tests/**/*.js'],
    ...jest.configs['flat/recommended'],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
  },
  prettier,
];

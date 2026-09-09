export default [
  {ignores: ['dist/**', 'node_modules/**']},
  {files: ['src/**/*.mjs', 'test/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {ecmaVersion: 'latest', sourceType: 'module'},
    rules: {'no-constant-binary-expression': 'error', 'no-unused-vars': ['error', {caughtErrors: 'none'}]}}
];

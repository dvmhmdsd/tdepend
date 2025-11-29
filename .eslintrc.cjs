module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/typescript',
    'prettier',
  ],
  env: {
    node: true,
    es2020: true,
    jest: false,
  },
  settings: {
    'import/resolver': {
      node: {
        extensions: ['.ts', '.tsx', '.js'],
      },
      typescript: {
        alwaysTryTypes: true,
      },
    },
  },
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    'import/order': [
      'error',
      {
        'alphabetize': { order: 'asc', caseInsensitive: true },
        'newlines-between': 'always',
      },
    ],
  },
};

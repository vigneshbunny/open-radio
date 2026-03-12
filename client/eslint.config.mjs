import next from 'eslint-config-next';

export default [
  ...next,
  {
    ignores: ['.next/**', 'out/**', 'dist/**', 'node_modules/**']
  }
];


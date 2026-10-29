// Gherkin acceptance tests (SPEC clause 12.2). Run: npm run test:bdd
export default {
  paths: ['features/**/*.feature'],
  import: ['features/step_definitions/**/*.ts'],
  format: ['progress', 'summary'],
  strict: true,
};

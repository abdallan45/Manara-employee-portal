// Unit tests: src/**/*.spec.ts. Integration tests: test/**/*.e2e-spec.ts (need the workforce_test database).
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/**/*.e2e-spec.ts'],
  setupFiles: ['<rootDir>/test/env.ts'],
  transform: { '^.+\.ts$': ['ts-jest', { isolatedModules: true }] },
  testTimeout: 30000,
};

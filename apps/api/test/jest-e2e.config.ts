import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '..',
  testEnvironment: 'node',
  testRegex: '.e2e-spec.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  globalSetup: '<rootDir>/test/global-setup.ts',
};

export default config;

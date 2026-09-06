import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '(src|scripts)/.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  collectCoverageFrom: ['src/**/*.ts'],
  testEnvironment: 'node',
  // I9: most of these suites call runMigrations() in beforeAll and share one
  // real Postgres database. TypeORM's migration executor takes no advisory
  // lock, so against a fresh database (as in CI, before this fix) several
  // Jest workers race on CREATE TABLE. Forcing serial execution — on top of
  // running `migration:run` before the test step in CI — removes the race.
  maxWorkers: 1,
};

export default config;

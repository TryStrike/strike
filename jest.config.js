const nextJest = require('next/jest')

const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files in your test environment
  dir: './',
})

// Add any custom config to be passed to Jest
const customJestConfig = {
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testEnvironment: 'jest-environment-jsdom',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    // Privy ships ESM jest will not parse - see test/stubs/walletSdk.js.
    '^@privy-io/react-auth$': '<rootDir>/test/stubs/walletSdk.js',
  },
  collectCoverageFrom: [
    'components/**/*.{js,jsx,ts,tsx}',
    'lib/**/*.{js,jsx,ts,tsx}',
    'app/**/*.{js,jsx,ts,tsx}',
    '!**/*.d.ts',
    '!**/node_modules/**',
    '!**/.next/**',
  ],
  testMatch: [
    '**/__tests__/**/*.[jt]s?(x)',
    '**/?(*.)+(spec|test).[jt]s?(x)',
  ],
  testPathIgnorePatterns: ['/node_modules/', '/.next/'],
}

// `jose` (pulled in by Privy) and a few of its neighbours ship ESM only. Jest
// does not transform node_modules by default, so importing them throws
// "Unexpected token 'export'". next/jest hardcodes transformIgnorePatterns and
// discards the value passed in customJestConfig, so override it afterwards.
const ESM_PACKAGES = [
  'jose',
  'preact',
  'uncrypto',
  'ox',
  'viem',
  'wagmi',
  '@wagmi',
  '@tanstack',
  'connectkit',
]

module.exports = async () => {
  const config = await createJestConfig(customJestConfig)()
  config.transformIgnorePatterns = [
    `/node_modules/(?!(${ESM_PACKAGES.join('|')})/)`,
    '^.+\\.module\\.(css|sass|scss)$',
  ]
  return config
}

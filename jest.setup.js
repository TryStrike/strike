// Learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom'

// Polyfill fetch for Node.js test environment
import fetch from 'cross-fetch'
global.fetch = fetch

// Polyfill Request and Response for Next.js API routes
import { Request, Response, Headers } from 'node-fetch'
global.Request = Request
global.Response = Response
global.Headers = Headers

// Polyfill TextEncoder and TextDecoder for Node.js test environment
import { TextEncoder, TextDecoder } from 'util'
global.TextEncoder = TextEncoder
global.TextDecoder = TextDecoder


// Route tests invoke handlers without x-strike-balance-key unless a suite sets this explicitly.
delete process.env.BALANCE_INTERNAL_SECRET
process.env.BALANCE_SETTLEMENT_SECRET = process.env.BALANCE_SETTLEMENT_SECRET || 'test-settlement-secret'

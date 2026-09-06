import { expect, test } from 'bun:test'

import { buildServerStartArgs } from '../electron/server-start-args'

test('passes the host through to the server CLI', () => {
  expect(buildServerStartArgs(4141, null, '0.0.0.0')).toEqual([
    'start',
    '--port',
    '4141',
    '--host',
    '0.0.0.0',
  ])
})

test('omits the host flag when no host is configured', () => {
  expect(buildServerStartArgs(4141, 'token', '   ')).toEqual([
    'start',
    '--port',
    '4141',
    '--github-token',
    'token',
  ])
  expect(buildServerStartArgs(4141, 'token')).toEqual([
    'start',
    '--port',
    '4141',
    '--github-token',
    'token',
  ])
})

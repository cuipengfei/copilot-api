import { expect, test } from 'bun:test'

import { buildServerStartArgs } from '../electron/server-start-args'

test('passes the host through to the server CLI', () => {
  expect(buildServerStartArgs(4141, '0.0.0.0')).toEqual([
    'start',
    '--port',
    '4141',
    '--host',
    '0.0.0.0',
  ])
})

test('omits the host flag when no host is configured', () => {
  expect(buildServerStartArgs(4141, '   ')).toEqual(['start', '--port', '4141'])
  expect(buildServerStartArgs(4141)).toEqual(['start', '--port', '4141'])
})

test('never puts the GitHub token on the command line', () => {
  expect(buildServerStartArgs(4141, '127.0.0.1')).not.toContain(
    '--github-token',
  )
})

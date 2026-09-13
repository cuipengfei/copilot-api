import { expect, test } from 'bun:test'

import {
  buildServerBaseUrl,
  isValidServerHost,
  resolveDisplayHost,
  resolveEffectiveServerHost,
} from '../src/lib/server-url'

test('maps wildcard binds back to loopback for display', () => {
  expect(resolveDisplayHost('')).toBe('localhost')
  expect(resolveDisplayHost('   ')).toBe('localhost')
  expect(resolveDisplayHost('0.0.0.0')).toBe('localhost')
  expect(resolveDisplayHost('::')).toBe('localhost')
  expect(resolveDisplayHost('[::]')).toBe('localhost')
  expect(resolveDisplayHost('127.0.0.1')).toBe('127.0.0.1')
  expect(resolveDisplayHost('  192.168.1.10  ')).toBe('192.168.1.10')
})

test('builds base urls for ipv4 and ipv6 hosts', () => {
  expect(buildServerBaseUrl('', 4141)).toBe('http://localhost:4141')
  expect(buildServerBaseUrl('0.0.0.0', 4141)).toBe('http://localhost:4141')
  expect(buildServerBaseUrl('::1', 4141)).toBe('http://[::1]:4141')
  expect(buildServerBaseUrl('[::1]', 4141)).toBe('http://[::1]:4141')
  expect(buildServerBaseUrl('192.168.1.10', 4141)).toBe(
    'http://192.168.1.10:4141',
  )
})

test('accepts blank hosts and rejects hosts the server would refuse', () => {
  expect(isValidServerHost('')).toBe(true)
  expect(isValidServerHost('   ')).toBe(true)
  expect(isValidServerHost('127.0.0.1')).toBe(true)
  expect(isValidServerHost('0.0.0.0')).toBe(true)
  expect(isValidServerHost('::1')).toBe(true)
  expect(isValidServerHost('[::1]')).toBe(true)
  expect(isValidServerHost('desktop.local')).toBe(true)

  expect(isValidServerHost('127.0.0.1 8080')).toBe(false)
  expect(isValidServerHost('http://127.0.0.1')).toBe(false)
  expect(isValidServerHost('127.0.0.1/usage')).toBe(false)
  expect(isValidServerHost('127.0.0.1?x=1')).toBe(false)
  expect(isValidServerHost('127.0.0.1#x')).toBe(false)
})

test('prefers the persisted host when the caller omits it', () => {
  expect(resolveEffectiveServerHost(undefined, '  0.0.0.0  ')).toBe('0.0.0.0')
  expect(resolveEffectiveServerHost(undefined, '')).toBe('')
  expect(resolveEffectiveServerHost(undefined, null)).toBe('')
  expect(resolveEffectiveServerHost(undefined, undefined)).toBe('')
  expect(resolveEffectiveServerHost('  127.0.0.1  ', '0.0.0.0')).toBe(
    '127.0.0.1',
  )
  expect(resolveEffectiveServerHost('', '0.0.0.0')).toBe('')
})

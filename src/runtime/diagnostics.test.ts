import { describe, expect, it } from 'vitest'
import { RuntimeClientError, RuntimeHealth, RuntimeSessionState } from './client'
import { buildDiagnostics, capabilityBreakdown, categorizeError, hasRequiredCapabilities, isDegraded, userFriendlyError } from './diagnostics'

const baseHealth: RuntimeHealth = { runtime: 'AGENT', version: '0.1.0', capabilities: ['session', 'commands'], timestamp: '2026-10-11T12:00:00Z' }

describe('error categorization', () => {
  it('categorizes DISCONNECTED as BACKEND_NOT_RUNNING', () => {
    expect(categorizeError(new RuntimeClientError('DISCONNECTED', 'msg', true))).toBe('BACKEND_NOT_RUNNING')
  })
  it('categorizes TIMEOUT as TIMEOUT', () => {
    expect(categorizeError(new RuntimeClientError('TIMEOUT', 'msg', true))).toBe('TIMEOUT')
  })
  it('categorizes MALFORMED_JSON as INVALID_RESPONSE', () => {
    expect(categorizeError(new RuntimeClientError('MALFORMED_JSON', 'msg'))).toBe('INVALID_RESPONSE')
  })
  it('categorizes MALFORMED_RESPONSE as INVALID_RESPONSE', () => {
    expect(categorizeError(new RuntimeClientError('MALFORMED_RESPONSE', 'msg'))).toBe('INVALID_RESPONSE')
  })
  it('categorizes HTTP_403 as HTTP_ERROR', () => {
    expect(categorizeError(new RuntimeClientError('HTTP_403', 'msg', false))).toBe('HTTP_ERROR')
  })
  it('categorizes unknown codes as UNKNOWN', () => {
    expect(categorizeError(new RuntimeClientError('WEIRD', 'msg'))).toBe('UNKNOWN')
  })
})

describe('user-friendly error messages', () => {
  it('provides a clear message for backend not running', () => {
    const msg = userFriendlyError(new RuntimeClientError('DISCONNECTED', 'failed', true))
    expect(msg).toContain('not running')
  })
  it('provides a clear message for timeout', () => {
    const msg = userFriendlyError(new RuntimeClientError('TIMEOUT', 'timed out', true))
    expect(msg).toContain('did not respond')
  })
  it('provides a clear message for invalid response', () => {
    const msg = userFriendlyError(new RuntimeClientError('MALFORMED_RESPONSE', 'bad'))
    expect(msg).toContain('did not match')
  })
  it('includes the HTTP status in HTTP error messages', () => {
    const msg = userFriendlyError(new RuntimeClientError('HTTP_403', 'forbidden'))
    expect(msg).toContain('403')
  })
})

describe('capability checking', () => {
  it('detects all required capabilities present', () => {
    expect(hasRequiredCapabilities(['session', 'commands', 'voice'])).toBe(true)
  })
  it('detects missing required capability', () => {
    expect(hasRequiredCapabilities(['session'])).toBe(false)
    expect(hasRequiredCapabilities([])).toBe(false)
  })
  it('marks runtime as degraded when required capabilities missing', () => {
    expect(isDegraded({ ...baseHealth, capabilities: ['session'] })).toBe(true)
    expect(isDegraded(baseHealth)).toBe(false)
  })
  it('breaks down capabilities with required/optional info', () => {
    const breakdown = capabilityBreakdown(['session', 'voice'])
    expect(breakdown).toHaveLength(3)
    expect(breakdown[0]).toEqual({ name: 'session', available: true, required: true })
    expect(breakdown[1]).toEqual({ name: 'commands', available: false, required: true })
    expect(breakdown[2]).toEqual({ name: 'voice', available: true, required: false })
  })
})

describe('diagnostics builder', () => {
  it('builds entries for a fully connected runtime', () => {
    const entries = buildDiagnostics('CONNECTED', baseHealth, 'ACTIVE', '12:00:00', null)
    expect(entries.length).toBeGreaterThan(5)
    const conn = entries.find((e) => e.label === 'Connection state')
    expect(conn?.value).toBe('CONNECTED')
    expect(conn?.confirmed).toBe(true)
    expect(conn?.tone).toBe('green')
  })
  it('marks DEGRADED state as confirmed with amber tone', () => {
    const entries = buildDiagnostics('DEGRADED', { ...baseHealth, capabilities: ['session'] }, 'INACTIVE', '12:00:00', null)
    const conn = entries.find((e) => e.label === 'Connection state')
    expect(conn?.tone).toBe('amber')
    expect(conn?.confirmed).toBe(true)
  })
  it('shows error category when an error exists', () => {
    const error = new RuntimeClientError('DISCONNECTED', 'msg', true)
    const entries = buildDiagnostics('ERROR', null, 'INACTIVE', null, error)
    const errEntry = entries.find((e) => e.label === 'Last error category')
    expect(errEntry?.value).toBe('BACKEND_NOT_RUNNING')
    expect(errEntry?.tone).toBe('red')
  })
  it('shows Never for last health check when null', () => {
    const entries = buildDiagnostics('DISCONNECTED', null, 'INACTIVE', null, null)
    const hc = entries.find((e) => e.label === 'Last health check')
    expect(hc?.value).toBe('Never')
    expect(hc?.confirmed).toBe(false)
  })
  it('shows AI provider when reported', () => {
    const healthWithAi: RuntimeHealth = { ...baseHealth, aiProvider: { name: 'Ollama', model: 'llama3', status: 'READY' } }
    const entries = buildDiagnostics('CONNECTED', healthWithAi, 'ACTIVE', '12:00:00', null)
    const ai = entries.find((e) => e.label === 'AI provider')
    expect(ai?.value).toContain('Ollama')
    expect(ai?.value).toContain('llama3')
    expect(ai?.confirmed).toBe(true)
  })
  it('shows Not reported for AI provider when absent', () => {
    const entries = buildDiagnostics('CONNECTED', baseHealth, 'ACTIVE', '12:00:00', null)
    const ai = entries.find((e) => e.label === 'AI provider')
    expect(ai?.value).toBe('Not reported')
    expect(ai?.confirmed).toBe(false)
  })
  it('lists each capability as available or missing', () => {
    const entries = buildDiagnostics('CONNECTED', { ...baseHealth, capabilities: ['session'] }, 'ACTIVE', '12:00:00', null)
    const commands = entries.find((e) => e.label === 'Capability: commands')
    expect(commands?.value).toContain('Missing')
    expect(commands?.tone).toBe('red')
    const session = entries.find((e) => e.label === 'Capability: session')
    expect(session?.value).toBe('Available')
    expect(session?.tone).toBe('green')
  })
  it('marks session state as unconfirmed when health is null', () => {
    const entries = buildDiagnostics('DISCONNECTED', null, 'INACTIVE' as RuntimeSessionState, null, null)
    const sess = entries.find((e) => e.label === 'Session state')
    expect(sess?.confirmed).toBe(false)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { isVerifiedCompletion, RuntimeClient, RuntimeClientError, RuntimeCommandResult, RuntimeControlResult } from './client'

const response = (body: unknown, ok = true, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const health = { runtime: 'AGENT', version: '0.1.0', capabilities: ['session', 'commands'], timestamp: '2026-10-11T12:00:00Z' }
const session = { state: 'ACTIVE', sessionId: 'session-1', timestamp: '2026-10-11T12:00:00Z' }
const command: RuntimeCommandResult = { commandId: 'command-1', status: 'COMPLETED', sessionState: 'ACTIVE', progress: [], result: 'Verified result', verified: true, error: null, startedAt: '2026-10-11T12:00:00Z', finishedAt: '2026-10-11T12:00:01Z' }

describe('RuntimeClient', () => {
  it('uses the narrow same-origin runtime path and maps a command result', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(command))
    const client = new RuntimeClient('/api/runtime', 1000, fetcher)
    await expect(client.command('Open Notepad', 'client-1')).resolves.toMatchObject({ commandId: 'command-1', status: 'COMPLETED', verified: true })
    expect(fetcher).toHaveBeenCalledWith('/api/runtime/commands', expect.objectContaining({ method: 'POST', body: JSON.stringify({ command: 'Open Notepad', clientCommandId: 'client-1' }) }))
  })

  it('rejects arbitrary origins', () => {
    expect(() => new RuntimeClient('http://localhost:9999')).toThrow('same-origin')
    expect(() => new RuntimeClient('//api/runtime')).toThrow('same-origin')
  })

  it('maps connection failures and timeouts', async () => {
    const disconnected = new RuntimeClient('/api/runtime', 1000, vi.fn().mockRejectedValue(new Error('offline')))
    await expect(disconnected.health()).rejects.toMatchObject<Partial<RuntimeClientError>>({ code: 'DISCONNECTED', retryable: true })
    const timeout = new RuntimeClient('/api/runtime', 1, vi.fn().mockImplementation((_url, options: RequestInit) => new Promise((_resolve, reject) => { options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))) })))
    await expect(timeout.health()).rejects.toMatchObject<Partial<RuntimeClientError>>({ code: 'TIMEOUT', retryable: true })
  })

  it('rejects malformed responses instead of manufacturing a result', async () => {
    const client = new RuntimeClient('/api/runtime', 1000, vi.fn().mockResolvedValue(response({ ...command, verified: 'yes' })))
    await expect(client.command('Open Notepad', 'client-1')).rejects.toMatchObject<Partial<RuntimeClientError>>({ code: 'MALFORMED_RESPONSE' })
  })

  it('rejects malformed JSON', async () => {
    const badJson = new Response('not json', { status: 200, headers: { 'Content-Type': 'application/json' } })
    const client = new RuntimeClient('/api/runtime', 1000, vi.fn().mockResolvedValue(badJson))
    await expect(client.health()).rejects.toMatchObject<Partial<RuntimeClientError>>({ code: 'MALFORMED_JSON' })
  })

  it('maps HTTP 403 as non-retryable (unauthorized transition)', async () => {
    const client = new RuntimeClient('/api/runtime', 1000, vi.fn().mockResolvedValue(new Response('{}', { status: 403 })))
    await expect(client.control('TAKE_OVER')).rejects.toMatchObject<Partial<RuntimeClientError>>({ code: 'HTTP_403', retryable: false })
  })

  it('maps HTTP 500 as retryable', async () => {
    const client = new RuntimeClient('/api/runtime', 1000, vi.fn().mockResolvedValue(new Response('{}', { status: 503 })))
    await expect(client.health()).rejects.toMatchObject<Partial<RuntimeClientError>>({ code: 'HTTP_503', retryable: true })
  })

  it('does not treat an unverified runtime response as success', () => {
    expect(isVerifiedCompletion({ ...command, verified: false })).toBe(false)
    expect(isVerifiedCompletion({ ...command, result: null })).toBe(false)
    expect(isVerifiedCompletion({ ...command, status: 'FAILED' })).toBe(false)
    expect(isVerifiedCompletion(command)).toBe(true)
  })

  it('maps health, session, and control responses', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(health)).mockResolvedValueOnce(response(session)).mockResolvedValueOnce(response({ action: 'PAUSE', state: 'PAUSED', sessionId: 'session-1', timestamp: health.timestamp, error: null }))
    const client = new RuntimeClient('/api/runtime', 1000, fetcher)
    await expect(client.health()).resolves.toMatchObject({ runtime: 'AGENT' })
    await expect(client.session()).resolves.toMatchObject({ state: 'ACTIVE' })
    await expect(client.control('PAUSE')).resolves.toMatchObject({ action: 'PAUSE', state: 'PAUSED' })
  })

  it('maps all five session states from the runtime', async () => {
    const states = ['INACTIVE', 'ACTIVE', 'PAUSED', 'STOPPED', 'RELEASED'] as const
    for (const state of states) {
      const fetcher = vi.fn().mockResolvedValue(response({ state, sessionId: null, timestamp: '2026-10-11T12:00:00Z' }))
      const client = new RuntimeClient('/api/runtime', 1000, fetcher)
      const result = await client.session()
      expect(result.state).toBe(state)
    }
  })

  it('maps a FAILED command result with error payload', async () => {
    const failed: RuntimeCommandResult = { ...command, status: 'FAILED', result: null, verified: false, error: { code: 'PERMISSION_DENIED', message: 'Not allowed.', retryable: false } }
    const client = new RuntimeClient('/api/runtime', 1000, vi.fn().mockResolvedValue(response(failed)))
    const result = await client.command('Delete system files', 'client-1')
    expect(result.status).toBe('FAILED')
    expect(result.verified).toBe(false)
    expect(result.error?.code).toBe('PERMISSION_DENIED')
    expect(isVerifiedCompletion(result)).toBe(false)
  })

  it('maps a CANCELLED command result', async () => {
    const cancelled: RuntimeCommandResult = { ...command, status: 'CANCELLED', result: null, verified: false, finishedAt: '2026-10-11T12:00:02Z' }
    const client = new RuntimeClient('/api/runtime', 1000, vi.fn().mockResolvedValue(response(cancelled)))
    const result = await client.command('Open Notepad', 'client-1')
    expect(result.status).toBe('CANCELLED')
    expect(isVerifiedCompletion(result)).toBe(false)
  })

  it('maps progress entries in a command result', async () => {
    const withProgress: RuntimeCommandResult = { ...command, progress: [
      { commandId: 'command-1', stage: 'Parsing', message: 'Interpreting command', timestamp: '2026-10-11T12:00:00Z' },
      { commandId: 'command-1', stage: 'Executing', message: 'Opening Notepad', timestamp: '2026-10-11T12:00:00.5Z' },
    ] }
    const client = new RuntimeClient('/api/runtime', 1000, vi.fn().mockResolvedValue(response(withProgress)))
    const result = await client.command('Open Notepad', 'client-1')
    expect(result.progress).toHaveLength(2)
    expect(result.progress[0].stage).toBe('Parsing')
    expect(result.progress[1].message).toBe('Opening Notepad')
  })

  it('rejects a health response with wrong runtime name', async () => {
    const client = new RuntimeClient('/api/runtime', 1000, vi.fn().mockResolvedValue(response({ ...health, runtime: 'OTHER' })))
    await expect(client.health()).rejects.toMatchObject<Partial<RuntimeClientError>>({ code: 'MALFORMED_RESPONSE' })
  })

  it('rejects a session response with an invalid state', async () => {
    const client = new RuntimeClient('/api/runtime', 1000, vi.fn().mockResolvedValue(response({ state: 'RUNNING', sessionId: null, timestamp: '...' })))
    await expect(client.session()).rejects.toMatchObject<Partial<RuntimeClientError>>({ code: 'MALFORMED_RESPONSE' })
  })

  it('rejects a control response with an invalid action', async () => {
    const client = new RuntimeClient('/api/runtime', 1000, vi.fn().mockResolvedValue(response({ action: 'HACK', state: 'ACTIVE', sessionId: null, timestamp: '...', error: null })))
    await expect(client.control('TAKE_OVER')).rejects.toMatchObject<Partial<RuntimeClientError>>({ code: 'MALFORMED_RESPONSE' })
  })

  it('maps a control result with a runtime error', async () => {
    const errorResult: RuntimeControlResult = { action: 'TAKE_OVER', state: 'INACTIVE', sessionId: null, timestamp: '...', error: { code: 'SESSION_BUSY', message: 'Another session is active.', retryable: true } }
    const client = new RuntimeClient('/api/runtime', 1000, vi.fn().mockResolvedValue(response(errorResult)))
    const result = await client.control('TAKE_OVER')
    expect(result.error?.code).toBe('SESSION_BUSY')
    expect(result.state).toBe('INACTIVE')
  })

  it('encodes the command ID in the cancel path', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ ...command, status: 'CANCELLED' }))
    const client = new RuntimeClient('/api/runtime', 1000, fetcher)
    await client.cancel('cmd with spaces')
    expect(fetcher).toHaveBeenCalledWith('/api/runtime/commands/cmd%20with%20spaces/cancel', expect.objectContaining({ method: 'POST' }))
  })

  it('maps a user-initiated abort as ABORTED, not TIMEOUT', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn().mockImplementation((_url, options: RequestInit) => new Promise((_resolve, reject) => { options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))) }))
    const client = new RuntimeClient('/api/runtime', 10000, fetcher)
    const promise = client.command('Open Notepad', 'client-1', controller.signal)
    controller.abort()
    await expect(promise).rejects.toMatchObject<Partial<RuntimeClientError>>({ code: 'ABORTED', retryable: false })
  })

  it('distinguishes timeout from user abort when no external signal is provided', async () => {
    const fetcher = vi.fn().mockImplementation((_url, options: RequestInit) => new Promise((_resolve, reject) => { options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))) }))
    const client = new RuntimeClient('/api/runtime', 1, fetcher)
    await expect(client.command('Open Notepad', 'client-1')).rejects.toMatchObject<Partial<RuntimeClientError>>({ code: 'TIMEOUT', retryable: true })
  })
})

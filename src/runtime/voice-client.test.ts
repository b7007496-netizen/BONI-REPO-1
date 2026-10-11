import { describe, expect, it, vi } from 'vitest'
import { allUnavailable, mapVoiceStatus, VoiceClient, VoiceClientError } from './voice-client'

const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const ts = '2026-10-11T12:00:00Z'

const fullStatus = {
  wakeWord: { status: 'READY', phrase: 'AGENT', listening: false, microphone: 'GRANTED', confirmedByRuntime: true, detail: null },
  recognition: { status: 'READY', engineName: 'whisper-local', microphone: 'GRANTED', confirmedByRuntime: true, detail: null },
  speakerAuth: { status: 'UNAVAILABLE', engineName: null, confirmedByRuntime: true, detail: 'No verifier connected.' },
  tts: { status: 'READY', engineName: 'piper-local', speaking: false, confirmedByRuntime: true, detail: null },
  timestamp: ts,
}

describe('allUnavailable', () => {
  it('reports every capability as unavailable with no runtime confirmation', () => {
    expect(allUnavailable.wakeWord.status).toBe('UNAVAILABLE')
    expect(allUnavailable.recognition.status).toBe('UNAVAILABLE')
    expect(allUnavailable.speakerAuth.status).toBe('UNAVAILABLE')
    expect(allUnavailable.tts.status).toBe('UNAVAILABLE')
    expect(allUnavailable.wakeWord.confirmedByRuntime).toBe(false)
    expect(allUnavailable.recognition.confirmedByRuntime).toBe(false)
    expect(allUnavailable.speakerAuth.confirmedByRuntime).toBe(false)
    expect(allUnavailable.tts.confirmedByRuntime).toBe(false)
    expect(allUnavailable.wakeWord.listening).toBe(false)
    expect(allUnavailable.tts.speaking).toBe(false)
  })

  it('defaults the wake phrase to AGENT', () => {
    expect(allUnavailable.wakeWord.phrase).toBe('AGENT')
  })

  it('defaults microphone to NOT_REQUESTED', () => {
    expect(allUnavailable.wakeWord.microphone).toBe('NOT_REQUESTED')
    expect(allUnavailable.recognition.microphone).toBe('NOT_REQUESTED')
  })
})

describe('mapVoiceStatus', () => {
  it('maps a well-formed runtime response', () => {
    const mapped = mapVoiceStatus(fullStatus)
    expect(mapped.wakeWord.status).toBe('READY')
    expect(mapped.recognition.engineName).toBe('whisper-local')
    expect(mapped.speakerAuth.status).toBe('UNAVAILABLE')
    expect(mapped.tts.speaking).toBe(false)
    expect(mapped.wakeWord.confirmedByRuntime).toBe(true)
  })

  it('rejects a malformed response instead of manufacturing status', () => {
    expect(() => mapVoiceStatus({ ...fullStatus, wakeWord: { ...fullStatus.wakeWord, status: 'BOGUS' } })).toThrow()
    expect(() => mapVoiceStatus({ ...fullStatus, timestamp: 123 })).toThrow()
    expect(() => mapVoiceStatus({ ...fullStatus, recognition: null })).toThrow()
  })

  it('rejects an invalid microphone state', () => {
    expect(() => mapVoiceStatus({ ...fullStatus, wakeWord: { ...fullStatus.wakeWord, microphone: 'YES' } })).toThrow()
  })

  it('maps ACTIVE wake-word with listening true', () => {
    const active = { ...fullStatus, wakeWord: { ...fullStatus.wakeWord, status: 'ACTIVE', listening: true } }
    const mapped = mapVoiceStatus(active)
    expect(mapped.wakeWord.status).toBe('ACTIVE')
    expect(mapped.wakeWord.listening).toBe(true)
  })

  it('maps ERROR status with detail', () => {
    const errored = { ...fullStatus, tts: { ...fullStatus.tts, status: 'ERROR', detail: 'Engine crashed.' } }
    const mapped = mapVoiceStatus(errored)
    expect(mapped.tts.status).toBe('ERROR')
    expect(mapped.tts.detail).toBe('Engine crashed.')
  })
})

describe('VoiceClient', () => {
  it('rejects arbitrary origins', () => {
    expect(() => new VoiceClient('http://localhost:9999')).toThrow('same-origin')
    expect(() => new VoiceClient('//api/runtime/voice')).toThrow('same-origin')
  })

  it('maps getStatus from a confirmed runtime', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok(fullStatus))
    const client = new VoiceClient('/api/runtime/voice', 1000, fetcher)
    await expect(client.getStatus()).resolves.toMatchObject({ wakeWord: { status: 'READY' } })
  })

  it('maps activation failure with microphone denial', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ activated: false, listening: false, microphone: 'DENIED', error: 'Microphone permission denied.', timestamp: ts }))
    const client = new VoiceClient('/api/runtime/voice', 1000, fetcher)
    await expect(client.activate()).resolves.toMatchObject({ activated: false, microphone: 'DENIED' })
  })

  it('maps successful activation', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ activated: true, listening: true, microphone: 'GRANTED', error: null, timestamp: ts }))
    const client = new VoiceClient('/api/runtime/voice', 1000, fetcher)
    await expect(client.activate()).resolves.toMatchObject({ activated: true, listening: true, microphone: 'GRANTED' })
  })

  it('maps recognition timeout and malformed responses', async () => {
    const timeoutResult = { requestId: 'req-1', transcript: null, status: 'TIMEOUT', error: 'No speech detected.', timestamp: ts }
    const fetcher = vi.fn().mockResolvedValue(ok(timeoutResult))
    const client = new VoiceClient('/api/runtime/voice', 1000, fetcher)
    await expect(client.recognize(5000)).resolves.toMatchObject({ status: 'TIMEOUT', transcript: null })

    const malformed = vi.fn().mockResolvedValue(ok({ requestId: 'req-1', status: 'BOGUS', timestamp: ts }))
    const malformedClient = new VoiceClient('/api/runtime/voice', 1000, malformed)
    await expect(malformedClient.recognize(5000)).rejects.toMatchObject<Partial<VoiceClientError>>({ code: 'MALFORMED_RESPONSE' })
  })

  it('maps recognition completion with transcript', async () => {
    const completed = { requestId: 'req-1', transcript: 'open notepad', status: 'COMPLETED', error: null, timestamp: ts }
    const fetcher = vi.fn().mockResolvedValue(ok(completed))
    const client = new VoiceClient('/api/runtime/voice', 1000, fetcher)
    await expect(client.recognize(5000)).resolves.toMatchObject({ status: 'COMPLETED', transcript: 'open notepad' })
  })

  it('maps TTS speak start and stop', async () => {
    const started = { requestId: 'req-1', status: 'STARTED', error: null, timestamp: ts }
    const fetcher = vi.fn().mockResolvedValueOnce(ok(started))
    const client = new VoiceClient('/api/runtime/voice', 1000, fetcher)
    await expect(client.speak('Command completed.')).resolves.toMatchObject({ status: 'STARTED' })
    expect(fetcher).toHaveBeenCalledWith('/api/runtime/voice/speak', expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'Command completed.' }) }))

    const stopResult = { requestId: 'req-1', status: 'STOPPED', error: null, timestamp: ts }
    const stopFetcher = vi.fn().mockResolvedValue(ok(stopResult))
    const stopClient = new VoiceClient('/api/runtime/voice', 1000, stopFetcher)
    await expect(stopClient.stopSpeaking()).resolves.toMatchObject({ status: 'STOPPED' })
  })

  it('maps TTS stop and disconnection', async () => {
    const stopResult = { requestId: 'req-1', status: 'STOPPED', error: null, timestamp: ts }
    const fetcher = vi.fn().mockResolvedValue(ok(stopResult))
    const client = new VoiceClient('/api/runtime/voice', 1000, fetcher)
    await expect(client.stopSpeaking()).resolves.toMatchObject({ status: 'STOPPED' })

    const disconnected = new VoiceClient('/api/runtime/voice', 1000, vi.fn().mockRejectedValue(new Error('offline')))
    await expect(disconnected.getStatus()).rejects.toMatchObject<Partial<VoiceClientError>>({ code: 'DISCONNECTED', retryable: true })
  })

  it('maps timeout on voice requests', async () => {
    const timeout = new VoiceClient('/api/runtime/voice', 1, vi.fn().mockImplementation((_url, options: RequestInit) => new Promise((_resolve, reject) => { options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))) })))
    await expect(timeout.getStatus()).rejects.toMatchObject<Partial<VoiceClientError>>({ code: 'TIMEOUT', retryable: true })
  })

  it('maps HTTP 503 as retryable from voice endpoints', async () => {
    const client = new VoiceClient('/api/runtime/voice', 1000, vi.fn().mockResolvedValue(new Response('{}', { status: 503 })))
    await expect(client.getStatus()).rejects.toMatchObject<Partial<VoiceClientError>>({ code: 'HTTP_503', retryable: true })
  })

  it('maps malformed JSON from voice endpoints', async () => {
    const badJson = new Response('not json', { status: 200, headers: { 'Content-Type': 'application/json' } })
    const client = new VoiceClient('/api/runtime/voice', 1000, vi.fn().mockResolvedValue(badJson))
    await expect(client.getStatus()).rejects.toMatchObject<Partial<VoiceClientError>>({ code: 'MALFORMED_JSON' })
  })

  it('keeps speaker authentication unavailable without a trusted verifier', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok(fullStatus))
    const client = new VoiceClient('/api/runtime/voice', 1000, fetcher)
    const status = await client.getStatus()
    expect(status.speakerAuth.status).toBe('UNAVAILABLE')
    expect(status.speakerAuth.confirmedByRuntime).toBe(true)
  })

  it('never shows ACTIVE for an unconnected engine', () => {
    const mapped = mapVoiceStatus({ ...fullStatus, wakeWord: { ...fullStatus.wakeWord, status: 'UNAVAILABLE', confirmedByRuntime: false, listening: false, microphone: 'NOT_REQUESTED', detail: 'Not connected.' } })
    expect(mapped.wakeWord.status).not.toBe('ACTIVE')
    expect(mapped.wakeWord.listening).toBe(false)
  })

  it('reports all four capabilities UNAVAILABLE when the runtime reports so', async () => {
    const allDown = {
      wakeWord: { status: 'UNAVAILABLE', phrase: 'AGENT', listening: false, microphone: 'NOT_REQUESTED', confirmedByRuntime: false, detail: 'Not connected.' },
      recognition: { status: 'UNAVAILABLE', engineName: null, microphone: 'NOT_REQUESTED', confirmedByRuntime: false, detail: 'Not connected.' },
      speakerAuth: { status: 'UNAVAILABLE', engineName: null, confirmedByRuntime: false, detail: 'Not connected.' },
      tts: { status: 'UNAVAILABLE', engineName: null, speaking: false, confirmedByRuntime: false, detail: 'Not connected.' },
      timestamp: ts,
    }
    const fetcher = vi.fn().mockResolvedValue(ok(allDown))
    const client = new VoiceClient('/api/runtime/voice', 1000, fetcher)
    const status = await client.getStatus()
    expect(status.wakeWord.status).toBe('UNAVAILABLE')
    expect(status.recognition.status).toBe('UNAVAILABLE')
    expect(status.speakerAuth.status).toBe('UNAVAILABLE')
    expect(status.tts.status).toBe('UNAVAILABLE')
    expect(status.wakeWord.confirmedByRuntime).toBe(false)
    expect(status.tts.confirmedByRuntime).toBe(false)
  })

  it('rejects a malformed activation response', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ activated: 'yes', listening: false, timestamp: ts }))
    const client = new VoiceClient('/api/runtime/voice', 1000, fetcher)
    await expect(client.activate()).rejects.toMatchObject<Partial<VoiceClientError>>({ code: 'MALFORMED_RESPONSE' })
  })

  it('rejects a malformed TTS result', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ requestId: 'req-1', status: 'BOGUS', timestamp: ts }))
    const client = new VoiceClient('/api/runtime/voice', 1000, fetcher)
    await expect(client.speak('test')).rejects.toMatchObject<Partial<VoiceClientError>>({ code: 'MALFORMED_RESPONSE' })
  })
})

import { RuntimeClientError } from './client'
export { RuntimeClientError as VoiceClientError } from './client'

export type VoiceCapabilityStatus = 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'READY' | 'ACTIVE' | 'ERROR'
export type MicrophoneState = 'NOT_REQUESTED' | 'GRANTED' | 'DENIED' | 'ERROR'
export type WakeWordState = { status: VoiceCapabilityStatus; phrase: string | null; listening: boolean; microphone: MicrophoneState; confirmedByRuntime: boolean; detail: string | null }
export type RecognitionState = { status: VoiceCapabilityStatus; engineName: string | null; microphone: MicrophoneState; confirmedByRuntime: boolean; detail: string | null }
export type SpeakerAuthState = { status: VoiceCapabilityStatus; engineName: string | null; confirmedByRuntime: boolean; detail: string | null }
export type TtsState = { status: VoiceCapabilityStatus; engineName: string | null; speaking: boolean; confirmedByRuntime: boolean; detail: string | null }
export type VoiceStatus = { wakeWord: WakeWordState; recognition: RecognitionState; speakerAuth: SpeakerAuthState; tts: TtsState; timestamp: string }
export type RecognitionResult = { requestId: string; transcript: string | null; status: 'COMPLETED' | 'TIMEOUT' | 'ERROR' | 'CANCELLED'; error: string | null; timestamp: string }
export type TtsResult = { requestId: string; status: 'STARTED' | 'COMPLETED' | 'STOPPED' | 'ERROR'; error: string | null; timestamp: string }
export type VoiceActivationResult = { activated: boolean; listening: boolean; microphone: MicrophoneState; error: string | null; timestamp: string }

export const allUnavailable: VoiceStatus = {
  wakeWord: { status: 'UNAVAILABLE', phrase: 'AGENT', listening: false, microphone: 'NOT_REQUESTED', confirmedByRuntime: false, detail: 'No wake-word detector is connected to the runtime.' },
  recognition: { status: 'UNAVAILABLE', engineName: null, microphone: 'NOT_REQUESTED', confirmedByRuntime: false, detail: 'No local speech-recognition engine is connected.' },
  speakerAuth: { status: 'UNAVAILABLE', engineName: null, confirmedByRuntime: false, detail: 'No trusted speaker-verification engine is connected.' },
  tts: { status: 'UNAVAILABLE', engineName: null, speaking: false, confirmedByRuntime: false, detail: 'No local text-to-speech engine is connected.' },
  timestamp: '',
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isStr = (value: unknown): value is string => typeof value === 'string'
const capabilityStatuses: VoiceCapabilityStatus[] = ['NOT_CONFIGURED', 'UNAVAILABLE', 'READY', 'ACTIVE', 'ERROR']
const microphoneStates: MicrophoneState[] = ['NOT_REQUESTED', 'GRANTED', 'DENIED', 'ERROR']
const hasStr = (values: string[], value: unknown): value is string => isStr(value) && values.includes(value)
const optStr = (value: unknown): string | null => value === null ? null : isStr(value) ? value : null
const optBool = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null

function validateMicrophone(value: unknown): MicrophoneState {
  if (!hasStr(microphoneStates, value)) throw new Error('Microphone state is invalid.')
  return value as MicrophoneState
}
function validateCapability(value: unknown): VoiceCapabilityStatus {
  if (!hasStr(capabilityStatuses, value)) throw new Error('Capability status is invalid.')
  return value as VoiceCapabilityStatus
}

function validateWakeWord(value: unknown): WakeWordState {
  if (!isRecord(value)) throw new Error('Wake-word state is invalid.')
  return {
    status: validateCapability(value.status),
    phrase: optStr(value.phrase),
    listening: optBool(value.listening) ?? false,
    microphone: validateMicrophone(value.microphone),
    confirmedByRuntime: optBool(value.confirmedByRuntime) ?? false,
    detail: optStr(value.detail),
  }
}
function validateRecognition(value: unknown): RecognitionState {
  if (!isRecord(value)) throw new Error('Recognition state is invalid.')
  return { status: validateCapability(value.status), engineName: optStr(value.engineName), microphone: validateMicrophone(value.microphone), confirmedByRuntime: optBool(value.confirmedByRuntime) ?? false, detail: optStr(value.detail) }
}
function validateSpeakerAuth(value: unknown): SpeakerAuthState {
  if (!isRecord(value)) throw new Error('Speaker-auth state is invalid.')
  return { status: validateCapability(value.status), engineName: optStr(value.engineName), confirmedByRuntime: optBool(value.confirmedByRuntime) ?? false, detail: optStr(value.detail) }
}
function validateTts(value: unknown): TtsState {
  if (!isRecord(value)) throw new Error('TTS state is invalid.')
  return { status: validateCapability(value.status), engineName: optStr(value.engineName), speaking: optBool(value.speaking) ?? false, confirmedByRuntime: optBool(value.confirmedByRuntime) ?? false, detail: optStr(value.detail) }
}

export function mapVoiceStatus(value: unknown): VoiceStatus {
  if (!isRecord(value) || !isRecord(value.wakeWord) || !isRecord(value.recognition) || !isRecord(value.speakerAuth) || !isRecord(value.tts) || !isStr(value.timestamp)) throw new Error('Voice status response is invalid.')
  return { wakeWord: validateWakeWord(value.wakeWord), recognition: validateRecognition(value.recognition), speakerAuth: validateSpeakerAuth(value.speakerAuth), tts: validateTts(value.tts), timestamp: value.timestamp }
}

export class VoiceClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetcher: typeof fetch

  constructor(baseUrl = '/api/runtime/voice', timeoutMs = 8000, fetcher: typeof fetch = fetch) {
    if (!baseUrl.startsWith('/') || baseUrl.startsWith('//')) throw new Error('Voice client must use a same-origin relative path.')
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.timeoutMs = timeoutMs
    this.fetcher = fetcher
  }

  async getStatus(): Promise<VoiceStatus> { return this.request('/status', 'GET', mapVoiceStatus) }
  async activate(): Promise<VoiceActivationResult> { return this.request('/activate', 'POST', validateActivation) }
  async deactivate(): Promise<VoiceActivationResult> { return this.request('/deactivate', 'POST', validateActivation) }
  async recognize(timeoutMs: number): Promise<RecognitionResult> { return this.request('/recognize', 'POST', validateRecognitionResult, { timeoutMs }) }
  async speak(text: string): Promise<TtsResult> { return this.request('/speak', 'POST', validateTtsResult, { text }) }
  async stopSpeaking(): Promise<TtsResult> { return this.request('/speak/stop', 'POST', validateTtsResult) }

  private async request<T>(path: string, method: 'GET' | 'POST', validator: (value: unknown) => T, body?: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = globalThis.setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal })
      if (!response.ok) throw new RuntimeClientError(`HTTP_${response.status}`, `Voice runtime returned HTTP ${response.status}.`, response.status >= 500)
      let payload: unknown
      try { payload = await response.json() } catch { throw new RuntimeClientError('MALFORMED_JSON', 'Voice runtime returned invalid JSON.') }
      try { return validator(payload) } catch (error) { throw new RuntimeClientError('MALFORMED_RESPONSE', error instanceof Error ? error.message : 'Voice runtime response did not match the contract.') }
    } catch (error) {
      if (error instanceof RuntimeClientError) throw error
      if (error instanceof DOMException && error.name === 'AbortError') throw new RuntimeClientError('TIMEOUT', 'Voice runtime did not respond before the request timed out.', true)
      throw new RuntimeClientError('DISCONNECTED', 'The trusted local voice runtime could not be reached.', true)
    } finally { globalThis.clearTimeout(timer) }
  }
}

function validateActivation(value: unknown): VoiceActivationResult {
  if (!isRecord(value) || typeof value.activated !== 'boolean' || typeof value.listening !== 'boolean' || !isStr(value.timestamp)) throw new Error('Activation response is invalid.')
  return { activated: value.activated, listening: value.listening, microphone: validateMicrophone(value.microphone), error: optStr(value.error), timestamp: value.timestamp }
}
function validateRecognitionResult(value: unknown): RecognitionResult {
  const statuses = ['COMPLETED', 'TIMEOUT', 'ERROR', 'CANCELLED']
  if (!isRecord(value) || !isStr(value.requestId) || !hasStr(statuses, value.status) || !isStr(value.timestamp)) throw new Error('Recognition result is invalid.')
  return { requestId: value.requestId, transcript: optStr(value.transcript), status: value.status as RecognitionResult['status'], error: optStr(value.error), timestamp: value.timestamp }
}
function validateTtsResult(value: unknown): TtsResult {
  const statuses = ['STARTED', 'COMPLETED', 'STOPPED', 'ERROR']
  if (!isRecord(value) || !isStr(value.requestId) || !hasStr(statuses, value.status) || !isStr(value.timestamp)) throw new Error('TTS result is invalid.')
  return { requestId: value.requestId, status: value.status as TtsResult['status'], error: optStr(value.error), timestamp: value.timestamp }
}

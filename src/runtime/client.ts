export type RuntimeConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'DEGRADED' | 'ERROR'
export type RuntimeSessionState = 'INACTIVE' | 'ACTIVE' | 'PAUSED' | 'STOPPED' | 'RELEASED'
export type RuntimeCommandStatus = 'ACCEPTED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
export type RuntimeControlAction = 'TAKE_OVER' | 'PAUSE' | 'STOP' | 'RELEASE_CONTROL'

export type RuntimeError = { code: string; message: string; retryable: boolean }
export type RuntimeAiProvider = { name: string; model: string | null; status: 'READY' | 'UNAVAILABLE' | 'ERROR' }
export type RuntimeHealth = { runtime: 'AGENT'; version: string | null; capabilities: string[]; timestamp: string; aiProvider?: RuntimeAiProvider | null }
export type RuntimeSession = { state: RuntimeSessionState; sessionId: string | null; timestamp: string }
export type RuntimeProgress = { commandId: string; stage: string; message: string; timestamp: string }
export type RuntimeCommandResult = { commandId: string; status: RuntimeCommandStatus; sessionState: RuntimeSessionState; progress: RuntimeProgress[]; result: string | null; verified: boolean; error: RuntimeError | null; startedAt: string; finishedAt: string | null }
export type RuntimeControlResult = { action: RuntimeControlAction; state: RuntimeSessionState; sessionId: string | null; timestamp: string; error: RuntimeError | null }

export const isVerifiedCompletion = (result: RuntimeCommandResult): boolean => result.status === 'COMPLETED' && result.verified && Boolean(result.result)

export class RuntimeClientError extends Error {
  readonly code: string
  readonly retryable: boolean
  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = 'RuntimeClientError'
    this.code = code
    this.retryable = retryable
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const text = (value: unknown): value is string => typeof value === 'string'
const runtimeStates: RuntimeSessionState[] = ['INACTIVE', 'ACTIVE', 'PAUSED', 'STOPPED', 'RELEASED']
const commandStatuses: RuntimeCommandStatus[] = ['ACCEPTED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']
const controlActions: RuntimeControlAction[] = ['TAKE_OVER', 'PAUSE', 'STOP', 'RELEASE_CONTROL']
const has = (values: string[], value: unknown): value is string => text(value) && values.includes(value)

export class RuntimeClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetcher: typeof fetch

  constructor(baseUrl = '/api/runtime', timeoutMs = 5000, fetcher: typeof fetch = fetch) {
    if (!baseUrl.startsWith('/') || baseUrl.startsWith('//')) throw new Error('Runtime client must use a same-origin relative path.')
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.timeoutMs = timeoutMs
    this.fetcher = fetcher
  }

  async health(): Promise<RuntimeHealth> { return this.request('/health', 'GET', validateHealth) }
  async session(): Promise<RuntimeSession> { return this.request('/session', 'GET', validateSession) }
  async control(action: RuntimeControlAction): Promise<RuntimeControlResult> {
    return this.request('/session/control', 'POST', validateControl, { action })
  }
  async command(command: string, clientCommandId: string, externalSignal?: AbortSignal): Promise<RuntimeCommandResult> {
    return this.request('/commands', 'POST', validateCommand, { command, clientCommandId }, externalSignal)
  }
  async cancel(commandId: string): Promise<RuntimeCommandResult> {
    return this.request(`/commands/${encodeURIComponent(commandId)}/cancel`, 'POST', validateCommand)
  }

  private async request<T>(path: string, method: 'GET' | 'POST', validator: (value: unknown) => T, body?: unknown, externalSignal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    const timer = globalThis.setTimeout(() => controller.abort(), this.timeoutMs)
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort()
      else externalSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal })
      if (!response.ok) throw new RuntimeClientError(`HTTP_${response.status}`, `Runtime returned HTTP ${response.status}.`, response.status >= 500)
      let payload: unknown
      try { payload = await response.json() } catch { throw new RuntimeClientError('MALFORMED_JSON', 'Runtime returned invalid JSON.') }
      try { return validator(payload) } catch (error) { throw new RuntimeClientError('MALFORMED_RESPONSE', error instanceof Error ? error.message : 'Runtime response did not match the contract.') }
    } catch (error) {
      if (error instanceof RuntimeClientError) throw error
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (externalSignal?.aborted) throw new RuntimeClientError('ABORTED', 'The request was cancelled by the user.', false)
        throw new RuntimeClientError('TIMEOUT', 'Runtime did not respond before the request timed out.', true)
      }
      throw new RuntimeClientError('DISCONNECTED', 'The trusted local runtime could not be reached.', true)
    } finally { globalThis.clearTimeout(timer) }
  }
}

function validateAiProvider(value: unknown): RuntimeAiProvider | null {
  if (value === null || value === undefined) return null
  const validStatuses = ['READY', 'UNAVAILABLE', 'ERROR']
  if (!isRecord(value) || !text(value.name) || (value.model !== null && !text(value.model)) || !has(validStatuses, value.status)) throw new Error('AI provider payload is invalid.')
  return { name: value.name, model: value.model, status: value.status as RuntimeAiProvider['status'] }
}
function validateHealth(value: unknown): RuntimeHealth {
  if (!isRecord(value) || value.runtime !== 'AGENT' || !text(value.timestamp) || (value.version !== null && !text(value.version)) || !Array.isArray(value.capabilities) || !value.capabilities.every(text)) throw new Error('Health response is invalid.')
  let aiProvider: RuntimeAiProvider | null | undefined = undefined
  if (value.aiProvider !== undefined) aiProvider = validateAiProvider(value.aiProvider)
  return { runtime: 'AGENT', version: value.version, capabilities: value.capabilities, timestamp: value.timestamp, ...(aiProvider !== undefined ? { aiProvider } : {}) }
}
function validateSession(value: unknown): RuntimeSession {
  if (!isRecord(value) || !has(runtimeStates, value.state) || (value.sessionId !== null && !text(value.sessionId)) || !text(value.timestamp)) throw new Error('Session response is invalid.')
  return { state: value.state as RuntimeSessionState, sessionId: value.sessionId, timestamp: value.timestamp }
}
function validateError(value: unknown): RuntimeError | null {
  if (value === null) return null
  if (!isRecord(value) || !text(value.code) || !text(value.message) || typeof value.retryable !== 'boolean') throw new Error('Error payload is invalid.')
  return { code: value.code, message: value.message, retryable: value.retryable }
}
function validateProgress(value: unknown): RuntimeProgress {
  if (!isRecord(value) || !text(value.commandId) || !text(value.stage) || !text(value.message) || !text(value.timestamp)) throw new Error('Progress payload is invalid.')
  return { commandId: value.commandId, stage: value.stage, message: value.message, timestamp: value.timestamp }
}
function validateCommand(value: unknown): RuntimeCommandResult {
  if (!isRecord(value) || !text(value.commandId) || !has(commandStatuses, value.status) || !has(runtimeStates, value.sessionState) || !Array.isArray(value.progress) || !value.progress.every((item) => { try { validateProgress(item); return true } catch { return false } }) || (value.result !== null && !text(value.result)) || typeof value.verified !== 'boolean' || !text(value.startedAt) || (value.finishedAt !== null && !text(value.finishedAt))) throw new Error('Command response is invalid.')
  return { commandId: value.commandId, status: value.status as RuntimeCommandStatus, sessionState: value.sessionState as RuntimeSessionState, progress: value.progress.map(validateProgress), result: value.result, verified: value.verified, error: validateError(value.error), startedAt: value.startedAt, finishedAt: value.finishedAt }
}
function validateControl(value: unknown): RuntimeControlResult {
  if (!isRecord(value) || !has(controlActions, value.action) || !has(runtimeStates, value.state) || (value.sessionId !== null && !text(value.sessionId)) || !text(value.timestamp)) throw new Error('Control response is invalid.')
  return { action: value.action as RuntimeControlAction, state: value.state as RuntimeSessionState, sessionId: value.sessionId, timestamp: value.timestamp, error: validateError(value.error) }
}

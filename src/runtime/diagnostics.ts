import { RuntimeClientError, RuntimeConnectionState, RuntimeHealth, RuntimeSessionState } from './client'

export type DiagnosticEntry = {
  label: string
  value: string
  confirmed: boolean
  tone: 'green' | 'amber' | 'red' | 'slate'
}

export type ErrorCategory =
  | 'BACKEND_NOT_RUNNING'
  | 'CONNECTION_REFUSED'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'HTTP_ERROR'
  | 'CAPABILITY_UNAVAILABLE'
  | 'SESSION_INVALID'
  | 'UNKNOWN'

export function categorizeError(error: RuntimeClientError): ErrorCategory {
  if (error.code === 'DISCONNECTED') return 'BACKEND_NOT_RUNNING'
  if (error.code === 'TIMEOUT') return 'TIMEOUT'
  if (error.code === 'MALFORMED_JSON' || error.code === 'MALFORMED_RESPONSE') return 'INVALID_RESPONSE'
  if (error.code.startsWith('HTTP_')) return 'HTTP_ERROR'
  return 'UNKNOWN'
}

export function userFriendlyError(error: RuntimeClientError): string {
  switch (categorizeError(error)) {
    case 'BACKEND_NOT_RUNNING': return 'The AGENT runtime is not running. Start the trusted local runtime on Windows, then retry.'
    case 'TIMEOUT': return 'The runtime did not respond in time. It may be busy or temporarily unavailable.'
    case 'INVALID_RESPONSE': return 'The runtime responded, but the data did not match the expected format.'
    case 'HTTP_ERROR': return `The runtime rejected the request (HTTP ${error.code.replace('HTTP_', '')}).`
    default: return error.message
  }
}

export function technicalDiagnostic(error: RuntimeClientError): string {
  return `${error.code}: ${error.message}`
}

export const REQUIRED_CAPABILITIES = ['session', 'commands'] as const
export const OPTIONAL_CAPABILITIES = ['voice'] as const

export function hasRequiredCapabilities(capabilities: string[]): boolean {
  return REQUIRED_CAPABILITIES.every((cap) => capabilities.includes(cap))
}

export function isDegraded(health: RuntimeHealth): boolean {
  return !hasRequiredCapabilities(health.capabilities)
}

export type CapabilityInfo = {
  name: string
  available: boolean
  required: boolean
}

export function capabilityBreakdown(capabilities: string[]): CapabilityInfo[] {
  const all = [...REQUIRED_CAPABILITIES, ...OPTIONAL_CAPABILITIES]
  return all.map((name) => ({
    name,
    available: capabilities.includes(name),
    required: REQUIRED_CAPABILITIES.includes(name as typeof REQUIRED_CAPABILITIES[number]),
  }))
}

export function buildDiagnostics(
  connectionState: RuntimeConnectionState,
  health: RuntimeHealth | null,
  session: RuntimeSessionState,
  lastHealthCheck: string | null,
  lastError: RuntimeClientError | null,
): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = []

  entries.push({
    label: 'Connection state',
    value: connectionState,
    confirmed: connectionState === 'CONNECTED' || connectionState === 'DEGRADED',
    tone: connectionState === 'CONNECTED' ? 'green' : connectionState === 'DEGRADED' ? 'amber' : connectionState === 'ERROR' ? 'red' : connectionState === 'CONNECTING' ? 'amber' : 'slate',
  })

  entries.push({
    label: 'Session state',
    value: session,
    confirmed: health !== null,
    tone: session === 'ACTIVE' ? 'green' : session === 'PAUSED' ? 'amber' : session === 'STOPPED' || session === 'RELEASED' ? 'red' : 'slate',
  })

  entries.push({
    label: 'Runtime version',
    value: health?.version ?? 'UNKNOWN',
    confirmed: health?.version != null,
    tone: health?.version ? 'green' : 'slate',
  })

  entries.push({
    label: 'Last health check',
    value: lastHealthCheck ?? 'Never',
    confirmed: lastHealthCheck !== null,
    tone: lastHealthCheck ? 'green' : 'slate',
  })

  entries.push({
    label: 'Last error category',
    value: lastError ? categorizeError(lastError) : 'None',
    confirmed: lastError !== null,
    tone: lastError ? 'red' : 'green',
  })

  if (health) {
    for (const cap of capabilityBreakdown(health.capabilities)) {
      entries.push({
        label: `Capability: ${cap.name}`,
        value: cap.available ? 'Available' : cap.required ? 'Missing (required)' : 'Unavailable',
        confirmed: true,
        tone: cap.available ? 'green' : cap.required ? 'red' : 'slate',
      })
    }
  }

  if (health?.aiProvider) {
    entries.push({
      label: 'AI provider',
      value: `${health.aiProvider.name}${health.aiProvider.model ? ` / ${health.aiProvider.model}` : ''}`,
      confirmed: true,
      tone: health.aiProvider.status === 'READY' ? 'green' : health.aiProvider.status === 'ERROR' ? 'red' : 'amber',
    })
  } else {
    entries.push({
      label: 'AI provider',
      value: 'Not reported',
      confirmed: false,
      tone: 'slate',
    })
  }

  return entries
}

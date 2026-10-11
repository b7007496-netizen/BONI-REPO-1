import { RuntimeConnectionState, RuntimeControlAction, RuntimeSessionState } from './client'
import { isValidTransition } from './session-transitions'

export type ActionType = 'VIEW_DIAGNOSTICS' | 'READ_SESSION' | 'TAKE_OVER' | 'PAUSE' | 'STOP' | 'RELEASE_CONTROL' | 'SUBMIT_COMMAND' | 'CANCEL_COMMAND' | 'VOICE_ACTIVATE' | 'VOICE_DEACTIVATE' | 'VOICE_STOP_SPEAKING'

export type EligibilityResult = {
  eligible: boolean
  reason: string | null
}

export type ActionContext = {
  connectionState: RuntimeConnectionState
  capabilities: string[]
  sessionState: RuntimeSessionState
  hasPendingOperation: boolean
}

const CAP_SESSION = 'session'
const CAP_COMMANDS = 'commands'
const CAP_VOICE = 'voice'

function hasCapability(capabilities: string[], cap: string): boolean {
  return capabilities.includes(cap)
}

function connectionEligible(ctx: ActionContext, requireConnected: boolean): EligibilityResult | null {
  if (requireConnected) {
    if (ctx.connectionState === 'DISCONNECTED') return { eligible: false, reason: 'The runtime is not connected.' }
    if (ctx.connectionState === 'CONNECTING') return { eligible: false, reason: 'The runtime is still connecting.' }
    if (ctx.connectionState === 'ERROR') return { eligible: false, reason: 'The runtime connection encountered an error.' }
  }
  return null
}

function capabilityEligible(ctx: ActionContext, requiredCaps: string[]): EligibilityResult | null {
  for (const cap of requiredCaps) {
    if (!hasCapability(ctx.capabilities, cap)) {
      return { eligible: false, reason: `The runtime did not report the required "${cap}" capability.` }
    }
  }
  return null
}

function sessionEligible(ctx: ActionContext, action: RuntimeControlAction): EligibilityResult | null {
  if (!isValidTransition(ctx.sessionState, action)) {
    return { eligible: false, reason: `${action.replace('_', ' ')} is not valid from ${ctx.sessionState.toLowerCase()} state.` }
  }
  return null
}

export function checkEligibility(action: ActionType, ctx: ActionContext): EligibilityResult {
  switch (action) {
    case 'VIEW_DIAGNOSTICS':
      return { eligible: true, reason: null }

    case 'READ_SESSION': {
      const conn = connectionEligible(ctx, true)
      if (conn) return conn
      const cap = capabilityEligible(ctx, [CAP_SESSION])
      if (cap) return cap
      return { eligible: true, reason: null }
    }

    case 'TAKE_OVER':
    case 'PAUSE':
    case 'STOP':
    case 'RELEASE_CONTROL': {
      const controlAction = action as RuntimeControlAction
      const conn = connectionEligible(ctx, true)
      if (conn) return conn
      const cap = capabilityEligible(ctx, [CAP_SESSION])
      if (cap) return cap
      const sess = sessionEligible(ctx, controlAction)
      if (sess) return sess
      if (ctx.hasPendingOperation) return { eligible: false, reason: 'Another control request is already in progress.' }
      return { eligible: true, reason: null }
    }

    case 'SUBMIT_COMMAND': {
      const conn = connectionEligible(ctx, true)
      if (conn) return conn
      const cap = capabilityEligible(ctx, [CAP_SESSION, CAP_COMMANDS])
      if (cap) return cap
      if (ctx.sessionState !== 'ACTIVE') return { eligible: false, reason: `Control is ${ctx.sessionState.toLowerCase()}. Commands require active control.` }
      if (ctx.hasPendingOperation) return { eligible: false, reason: 'A command is already running.' }
      return { eligible: true, reason: null }
    }

    case 'CANCEL_COMMAND': {
      if (!ctx.hasPendingOperation) return { eligible: false, reason: 'No command is running to cancel.' }
      return { eligible: true, reason: null }
    }

    case 'VOICE_ACTIVATE':
    case 'VOICE_DEACTIVATE':
    case 'VOICE_STOP_SPEAKING': {
      const conn = connectionEligible(ctx, true)
      if (conn) return conn
      const cap = capabilityEligible(ctx, [CAP_VOICE])
      if (cap) return cap
      if (ctx.hasPendingOperation) return { eligible: false, reason: 'A voice operation is already in progress.' }
      return { eligible: true, reason: null }
    }

    default:
      return { eligible: false, reason: 'Unknown action.' }
  }
}

export function isConnectionUsable(connectionState: RuntimeConnectionState): boolean {
  return connectionState === 'CONNECTED' || connectionState === 'DEGRADED'
}

export function isFullyConnected(connectionState: RuntimeConnectionState): boolean {
  return connectionState === 'CONNECTED'
}

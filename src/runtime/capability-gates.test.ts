import { describe, expect, it } from 'vitest'
import { ActionContext, ActionType, checkEligibility, isConnectionUsable, isFullyConnected } from './capability-gates'
import { RuntimeConnectionState, RuntimeSessionState } from './client'

const fullCaps = ['session', 'commands', 'voice']
const noCaps: string[] = []
const sessionOnly = ['session']
const commandsOnly = ['commands']
const sessionAndCommands = ['session', 'commands']

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    connectionState: 'CONNECTED',
    capabilities: fullCaps,
    sessionState: 'INACTIVE',
    hasPendingOperation: false,
    ...overrides,
  }
}

describe('isConnectionUsable', () => {
  it('treats CONNECTED and DEGRADED as usable', () => {
    expect(isConnectionUsable('CONNECTED')).toBe(true)
    expect(isConnectionUsable('DEGRADED')).toBe(true)
  })
  it('treats DISCONNECTED, CONNECTING, and ERROR as not usable', () => {
    expect(isConnectionUsable('DISCONNECTED')).toBe(false)
    expect(isConnectionUsable('CONNECTING')).toBe(false)
    expect(isConnectionUsable('ERROR')).toBe(false)
  })
})

describe('isFullyConnected', () => {
  it('only treats CONNECTED as fully connected', () => {
    expect(isFullyConnected('CONNECTED')).toBe(true)
    expect(isFullyConnected('DEGRADED')).toBe(false)
  })
})

describe('VIEW_DIAGNOSTICS', () => {
  it('is always eligible regardless of connection or capabilities', () => {
    expect(checkEligibility('VIEW_DIAGNOSTICS', ctx({ connectionState: 'DISCONNECTED', capabilities: noCaps })).eligible).toBe(true)
  })
})

describe('READ_SESSION', () => {
  it('requires a usable connection', () => {
    expect(checkEligibility('READ_SESSION', ctx({ connectionState: 'DISCONNECTED' })).eligible).toBe(false)
    expect(checkEligibility('READ_SESSION', ctx({ connectionState: 'ERROR' })).eligible).toBe(false)
  })
  it('requires the session capability', () => {
    expect(checkEligibility('READ_SESSION', ctx({ capabilities: commandsOnly })).eligible).toBe(false)
  })
  it('succeeds with session capability and connection', () => {
    expect(checkEligibility('READ_SESSION', ctx({ capabilities: sessionOnly })).eligible).toBe(true)
  })
})

describe('control actions (TAKE_OVER, PAUSE, STOP, RELEASE_CONTROL)', () => {
  it('blocks all control actions when session capability is missing', () => {
    const context = ctx({ capabilities: commandsOnly, sessionState: 'INACTIVE' })
    expect(checkEligibility('TAKE_OVER', context).eligible).toBe(false)
    expect(checkEligibility('TAKE_OVER', context).reason).toContain('session')
  })
  it('blocks when disconnected', () => {
    const context = ctx({ connectionState: 'DISCONNECTED', sessionState: 'INACTIVE' })
    expect(checkEligibility('TAKE_OVER', context).eligible).toBe(false)
  })
  it('blocks TAKE_OVER from ACTIVE (invalid transition)', () => {
    const context = ctx({ sessionState: 'ACTIVE' })
    expect(checkEligibility('TAKE_OVER', context).eligible).toBe(false)
    expect(checkEligibility('TAKE_OVER', context).reason).toContain('not valid')
  })
  it('allows TAKE_OVER from INACTIVE', () => {
    expect(checkEligibility('TAKE_OVER', ctx({ sessionState: 'INACTIVE' })).eligible).toBe(true)
  })
  it('allows PAUSE from ACTIVE', () => {
    expect(checkEligibility('PAUSE', ctx({ sessionState: 'ACTIVE' })).eligible).toBe(true)
  })
  it('allows STOP from ACTIVE', () => {
    expect(checkEligibility('STOP', ctx({ sessionState: 'ACTIVE' })).eligible).toBe(true)
  })
  it('allows RELEASE_CONTROL from ACTIVE', () => {
    expect(checkEligibility('RELEASE_CONTROL', ctx({ sessionState: 'ACTIVE' })).eligible).toBe(true)
  })
  it('blocks PAUSE from INACTIVE', () => {
    expect(checkEligibility('PAUSE', ctx({ sessionState: 'INACTIVE' })).eligible).toBe(false)
  })
  it('blocks when a pending control operation exists', () => {
    expect(checkEligibility('TAKE_OVER', ctx({ sessionState: 'INACTIVE', hasPendingOperation: true })).eligible).toBe(false)
  })
  it('DEGRADED does not bypass capability check — missing session blocks all control', () => {
    const degradedCtx = ctx({ connectionState: 'DEGRADED', capabilities: commandsOnly, sessionState: 'INACTIVE' })
    expect(checkEligibility('TAKE_OVER', degradedCtx).eligible).toBe(false)
    expect(checkEligibility('PAUSE', degradedCtx).eligible).toBe(false)
    expect(checkEligibility('STOP', degradedCtx).eligible).toBe(false)
    expect(checkEligibility('RELEASE_CONTROL', degradedCtx).eligible).toBe(false)
  })
  it('DEGRADED with session capability allows valid transitions', () => {
    const degradedCtx = ctx({ connectionState: 'DEGRADED', capabilities: sessionOnly, sessionState: 'INACTIVE' })
    expect(checkEligibility('TAKE_OVER', degradedCtx).eligible).toBe(true)
  })
})

describe('SUBMIT_COMMAND', () => {
  it('requires both session and commands capabilities', () => {
    expect(checkEligibility('SUBMIT_COMMAND', ctx({ capabilities: sessionOnly, sessionState: 'ACTIVE' })).eligible).toBe(false)
    expect(checkEligibility('SUBMIT_COMMAND', ctx({ capabilities: commandsOnly, sessionState: 'ACTIVE' })).eligible).toBe(false)
  })
  it('succeeds with both capabilities and ACTIVE session', () => {
    expect(checkEligibility('SUBMIT_COMMAND', ctx({ capabilities: sessionAndCommands, sessionState: 'ACTIVE' })).eligible).toBe(true)
  })
  it('blocks when session is not ACTIVE', () => {
    const result = checkEligibility('SUBMIT_COMMAND', ctx({ sessionState: 'INACTIVE' }))
    expect(result.eligible).toBe(false)
    expect(result.reason).toContain('inactive')
  })
  it('blocks when a command is already running', () => {
    expect(checkEligibility('SUBMIT_COMMAND', ctx({ sessionState: 'ACTIVE', hasPendingOperation: true })).eligible).toBe(false)
  })
  it('blocks when disconnected', () => {
    expect(checkEligibility('SUBMIT_COMMAND', ctx({ connectionState: 'DISCONNECTED', sessionState: 'ACTIVE' })).eligible).toBe(false)
  })
  it('DEGRADED with both capabilities but non-ACTIVE session blocks commands', () => {
    const degradedCtx = ctx({ connectionState: 'DEGRADED', capabilities: sessionAndCommands, sessionState: 'INACTIVE' })
    expect(checkEligibility('SUBMIT_COMMAND', degradedCtx).eligible).toBe(false)
  })
  it('DEGRADED with missing commands capability blocks commands even if ACTIVE', () => {
    const degradedCtx = ctx({ connectionState: 'DEGRADED', capabilities: sessionOnly, sessionState: 'ACTIVE' })
    expect(checkEligibility('SUBMIT_COMMAND', degradedCtx).eligible).toBe(false)
    expect(degradedCtx && checkEligibility('SUBMIT_COMMAND', degradedCtx).reason).toContain('commands')
  })
})

describe('CANCEL_COMMAND', () => {
  it('requires a pending operation', () => {
    expect(checkEligibility('CANCEL_COMMAND', ctx({ hasPendingOperation: false })).eligible).toBe(false)
  })
  it('succeeds when a command is running', () => {
    expect(checkEligibility('CANCEL_COMMAND', ctx({ hasPendingOperation: true })).eligible).toBe(true)
  })
})

describe('VOICE actions', () => {
  it('requires the voice capability', () => {
    const context = ctx({ capabilities: sessionAndCommands })
    expect(checkEligibility('VOICE_ACTIVATE', context).eligible).toBe(false)
    expect(checkEligibility('VOICE_ACTIVATE', context).reason).toContain('voice')
  })
  it('succeeds with voice capability and connection', () => {
    expect(checkEligibility('VOICE_ACTIVATE', ctx()).eligible).toBe(true)
  })
  it('blocks when a voice operation is in progress', () => {
    expect(checkEligibility('VOICE_ACTIVATE', ctx({ hasPendingOperation: true })).eligible).toBe(false)
  })
  it('blocks when disconnected', () => {
    expect(checkEligibility('VOICE_ACTIVATE', ctx({ connectionState: 'DISCONNECTED' })).eligible).toBe(false)
  })
  it('DEGRADED without voice capability blocks voice actions', () => {
    const degradedCtx = ctx({ connectionState: 'DEGRADED', capabilities: sessionAndCommands })
    expect(checkEligibility('VOICE_ACTIVATE', degradedCtx).eligible).toBe(false)
    expect(checkEligibility('VOICE_DEACTIVATE', degradedCtx).eligible).toBe(false)
    expect(checkEligibility('VOICE_STOP_SPEAKING', degradedCtx).eligible).toBe(false)
  })
  it('DEGRADED with voice capability allows voice actions', () => {
    const degradedCtx = ctx({ connectionState: 'DEGRADED', capabilities: fullCaps })
    expect(checkEligibility('VOICE_ACTIVATE', degradedCtx).eligible).toBe(true)
  })
})

describe('stale connection cannot re-enable actions', () => {
  it('ERROR state blocks all actions even if capabilities were previously known', () => {
    const errorCtx = ctx({ connectionState: 'ERROR', capabilities: fullCaps, sessionState: 'ACTIVE' })
    expect(checkEligibility('SUBMIT_COMMAND', errorCtx).eligible).toBe(false)
    expect(checkEligibility('TAKE_OVER', errorCtx).eligible).toBe(false)
    expect(checkEligibility('VOICE_ACTIVATE', errorCtx).eligible).toBe(false)
  })
  it('CONNECTING state blocks all action-level operations', () => {
    const connectingCtx = ctx({ connectionState: 'CONNECTING', capabilities: fullCaps, sessionState: 'ACTIVE' })
    expect(checkEligibility('SUBMIT_COMMAND', connectingCtx).eligible).toBe(false)
    expect(checkEligibility('TAKE_OVER', connectingCtx).eligible).toBe(false)
  })
})

describe('reconnection does not restore session authority', () => {
  it('after reconnection to INACTIVE, TAKE_OVER is required before commands', () => {
    const reconnectedCtx = ctx({ connectionState: 'CONNECTED', capabilities: fullCaps, sessionState: 'INACTIVE' })
    expect(checkEligibility('SUBMIT_COMMAND', reconnectedCtx).eligible).toBe(false)
    expect(checkEligibility('SUBMIT_COMMAND', reconnectedCtx).reason).toContain('inactive')
    expect(checkEligibility('TAKE_OVER', reconnectedCtx).eligible).toBe(true)
  })
  it('after reconnection to STOPPED, only RELEASE_CONTROL is allowed', () => {
    const stoppedCtx = ctx({ connectionState: 'CONNECTED', capabilities: fullCaps, sessionState: 'STOPPED' })
    expect(checkEligibility('SUBMIT_COMMAND', stoppedCtx).eligible).toBe(false)
    expect(checkEligibility('TAKE_OVER', stoppedCtx).eligible).toBe(false)
    expect(checkEligibility('PAUSE', stoppedCtx).eligible).toBe(false)
    expect(checkEligibility('RELEASE_CONTROL', stoppedCtx).eligible).toBe(true)
  })
})

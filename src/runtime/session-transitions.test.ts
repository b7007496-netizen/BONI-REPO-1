import { describe, expect, it } from 'vitest'
import { isValidTransition, allowedActions, isTerminalState, stopsActiveExecution } from './session-transitions'
import { RuntimeControlAction, RuntimeSessionState } from './client'

const states: RuntimeSessionState[] = ['INACTIVE', 'ACTIVE', 'PAUSED', 'STOPPED', 'RELEASED']
const actions: RuntimeControlAction[] = ['TAKE_OVER', 'PAUSE', 'STOP', 'RELEASE_CONTROL']

describe('session transition table', () => {
  it('allows TAKE_OVER from INACTIVE', () => {
    expect(isValidTransition('INACTIVE', 'TAKE_OVER')).toBe(true)
  })

  it('allows PAUSE, STOP, RELEASE_CONTROL from ACTIVE', () => {
    expect(isValidTransition('ACTIVE', 'PAUSE')).toBe(true)
    expect(isValidTransition('ACTIVE', 'STOP')).toBe(true)
    expect(isValidTransition('ACTIVE', 'RELEASE_CONTROL')).toBe(true)
  })

  it('allows TAKE_OVER (resume), STOP, RELEASE_CONTROL from PAUSED', () => {
    expect(isValidTransition('PAUSED', 'TAKE_OVER')).toBe(true)
    expect(isValidTransition('PAUSED', 'STOP')).toBe(true)
    expect(isValidTransition('PAUSED', 'RELEASE_CONTROL')).toBe(true)
  })

  it('allows only RELEASE_CONTROL from STOPPED', () => {
    expect(isValidTransition('STOPPED', 'RELEASE_CONTROL')).toBe(true)
    expect(isValidTransition('STOPPED', 'TAKE_OVER')).toBe(false)
    expect(isValidTransition('STOPPED', 'PAUSE')).toBe(false)
  })

  it('allows only TAKE_OVER from RELEASED', () => {
    expect(isValidTransition('RELEASED', 'TAKE_OVER')).toBe(true)
    expect(isValidTransition('RELEASED', 'PAUSE')).toBe(false)
    expect(isValidTransition('RELEASED', 'STOP')).toBe(false)
  })

  it('rejects TAKE_OVER from ACTIVE (already active)', () => {
    expect(isValidTransition('ACTIVE', 'TAKE_OVER')).toBe(false)
  })

  it('rejects PAUSE from INACTIVE', () => {
    expect(isValidTransition('INACTIVE', 'PAUSE')).toBe(false)
  })

  it('rejects all actions not in the transition table', () => {
    for (const state of states) {
      const allowed = new Set(allowedActions(state))
      for (const action of actions) {
        if (!allowed.has(action)) {
          expect(isValidTransition(state, action)).toBe(false)
        }
      }
    }
  })

  it('identifies STOPPED and RELEASED as terminal', () => {
    expect(isTerminalState('STOPPED')).toBe(true)
    expect(isTerminalState('RELEASED')).toBe(true)
    expect(isTerminalState('ACTIVE')).toBe(false)
    expect(isTerminalState('INACTIVE')).toBe(false)
    expect(isTerminalState('PAUSED')).toBe(false)
  })

  it('identifies STOP, PAUSE, RELEASE_CONTROL as stopping active execution', () => {
    expect(stopsActiveExecution('STOP')).toBe(true)
    expect(stopsActiveExecution('PAUSE')).toBe(true)
    expect(stopsActiveExecution('RELEASE_CONTROL')).toBe(true)
    expect(stopsActiveExecution('TAKE_OVER')).toBe(false)
  })
})

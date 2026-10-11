import { RuntimeControlAction, RuntimeSessionState } from './client'

export type ControlRequestState = 'IDLE' | 'SENDING' | 'CONFIRMED' | 'FAILED'

const transitionTable: Record<RuntimeSessionState, RuntimeControlAction[]> = {
  INACTIVE: ['TAKE_OVER'],
  ACTIVE: ['PAUSE', 'STOP', 'RELEASE_CONTROL'],
  PAUSED: ['TAKE_OVER', 'STOP', 'RELEASE_CONTROL'],
  STOPPED: ['RELEASE_CONTROL'],
  RELEASED: ['TAKE_OVER'],
}

export function isValidTransition(from: RuntimeSessionState, action: RuntimeControlAction): boolean {
  return transitionTable[from]?.includes(action) ?? false
}

export function allowedActions(state: RuntimeSessionState): RuntimeControlAction[] {
  return transitionTable[state] ?? []
}

export function isTerminalState(state: RuntimeSessionState): boolean {
  return state === 'STOPPED' || state === 'RELEASED'
}

export function stopsActiveExecution(action: RuntimeControlAction): boolean {
  return action === 'STOP' || action === 'PAUSE' || action === 'RELEASE_CONTROL'
}

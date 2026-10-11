import { FormEvent, KeyboardEvent, ReactNode, RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { isVerifiedCompletion, RuntimeClient, RuntimeClientError, RuntimeConnectionState, RuntimeControlAction, RuntimeHealth, RuntimeSessionState } from './runtime/client'
import { allUnavailable, VoiceClient, VoiceClientError, VoiceCapabilityStatus, VoiceStatus } from './runtime/voice-client'
import { ControlRequestState, isValidTransition, stopsActiveExecution } from './runtime/session-transitions'
import { buildDiagnostics, categorizeError, DiagnosticEntry, isDegraded, userFriendlyError } from './runtime/diagnostics'
import { ActionContext, ActionType, checkEligibility, isConnectionUsable } from './runtime/capability-gates'

type Page = 'workspace' | 'history' | 'voice' | 'settings' | 'diagnostics'
type SessionState = RuntimeSessionState
type EntryStatus = 'completed' | 'failed' | 'cancelled' | 'unknown'
type MessageKind = 'user' | 'agent' | 'progress' | 'error'

type Profile = { name: string; address: string }
type HistoryEntry = { id: string; command: string; timestamp: string; status: EntryStatus; duration: number; detail: string; runtimeConfirmed: boolean }
type Message = { id: string; kind: MessageKind; text: string; time: string; entryId?: string }

const now = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const uid = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`

function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
    plus: 'M12 5v14M5 12h14',
    clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
    mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3M8 21h8',
    settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.8 1.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V20h-2.5v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-1.8-1.8.1-.1A1.7 1.7 0 0 0 8.6 15a1.7 1.7 0 0 0-1.5-1H7v-2.5h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1L10 6.7l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V5H15v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 1.8 1.8-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1V13h-.1a1.7 1.7 0 0 0-1.5 1Z',
    user: 'M19 20a7 7 0 0 0-14 0M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
    arrow: 'M5 12h13M13 6l6 6-6 6',
    pause: 'M9 5v14M15 5v14',
    stop: 'M6 6h12v12H6z',
    play: 'm8 5 11 7-11 7V5Z',
    check: 'm5 12 4 4L19 6',
    close: 'm6 6 12 12M18 6 6 18',
    shield: 'M12 3 20 6v5c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6l8-3Z',
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true" className="icon"><path d={paths[name] || paths.grid} /></svg>
}

const initialMessages: Message[] = [
  { id: 'intro', kind: 'agent', text: 'Connect the trusted Windows runtime to begin. AGENT will only report actions confirmed by that runtime.', time: now() },
]

function App() {
  const [profile, setProfile] = useState<Profile | null>(() => JSON.parse(localStorage.getItem('agent-profile') || 'null'))
  const [onboardingStep, setOnboardingStep] = useState(profile ? 4 : 1)
  const [draftProfile, setDraftProfile] = useState<Profile>({ name: '', address: '' })
  const [page, setPage] = useState<Page>('workspace')
  const [session, setSession] = useState<SessionState>('INACTIVE')
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [command, setCommand] = useState('')
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState('Idle')
  const [history, setHistory] = useState<HistoryEntry[]>(() => JSON.parse(localStorage.getItem('agent-history') || '[]'))
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>(allUnavailable)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const voiceClient = useMemo(() => new VoiceClient(), [])
  const [historyFilter, setHistoryFilter] = useState<'all' | EntryStatus>('all')
  const [appearance, setAppearance] = useState<'midnight' | 'soft'>('midnight')
  const [runtimeState, setRuntimeState] = useState<RuntimeConnectionState>('DISCONNECTED')
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [runtimeErrorCode, setRuntimeErrorCode] = useState<RuntimeClientError | null>(null)
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealth | null>(null)
  const [lastHealthCheck, setLastHealthCheck] = useState<string | null>(null)
  const [controlPending, setControlPending] = useState<RuntimeControlAction | null>(null)
  const [controlState, setControlState] = useState<ControlRequestState>('IDLE')
  const runtimeClient = useMemo(() => new RuntimeClient(), [])
  const commandAbortRef = useRef<AbortController | null>(null)
  const commandSessionRef = useRef<SessionState>('INACTIVE')
  const connectSeqRef = useRef(0)
  const controlSeqRef = useRef(0)
  const messageListRef = useRef<HTMLDivElement>(null)

  useEffect(() => localStorage.setItem('agent-history', JSON.stringify(history)), [history])
  useEffect(() => { document.documentElement.dataset.theme = appearance }, [appearance])
  useEffect(() => { messageListRef.current?.scrollTo({ top: messageListRef.current.scrollHeight, behavior: 'smooth' }) }, [messages])
  useEffect(() => () => { commandAbortRef.current?.abort() }, [])

  const pageTitle = { workspace: 'Workspace', history: 'Command history', voice: 'Voice interface', diagnostics: 'Runtime diagnostics', settings: 'Settings' }[page]
  const sessionLabel = session === 'INACTIVE' ? 'Control inactive' : session === 'ACTIVE' ? 'Control active' : `Control ${session.toLowerCase()}`
  const capabilities = runtimeHealth?.capabilities ?? []
  const actionContext: ActionContext = { connectionState: runtimeState, capabilities, sessionState: session, hasPendingOperation: processing }
  const commandEligibility = checkEligibility('SUBMIT_COMMAND', actionContext)
  const canAct = commandEligibility.eligible
  const filteredHistory = useMemo(() => history.filter((entry) => historyFilter === 'all' || entry.status === historyFilter), [history, historyFilter])

  const saveProfile = (event: FormEvent) => {
    event.preventDefault()
    if (!draftProfile.name.trim()) return
    const next = { name: draftProfile.name.trim(), address: draftProfile.address.trim() }
    setProfile(next)
    localStorage.setItem('agent-profile', JSON.stringify(next))
    setOnboardingStep(3)
  }

  const resetDemo = () => {
    localStorage.removeItem('agent-profile')
    localStorage.removeItem('agent-history')
    setProfile(null)
    setHistory([])
    setMessages(initialMessages)
    setSession('INACTIVE')
    commandSessionRef.current = 'INACTIVE'
    setOnboardingStep(1)
  }

  const addMessage = (kind: MessageKind, text: string, entryId?: string) => setMessages((current) => [...current, { id: uid(), kind, text, time: now(), entryId }])

  const connectRuntime = async () => {
    if (runtimeState === 'CONNECTING') return
    const seq = ++connectSeqRef.current
    setRuntimeState('CONNECTING')
    setRuntimeError(null)
    setRuntimeErrorCode(null)
    try {
      const health = await runtimeClient.health()
      if (seq !== connectSeqRef.current) return
      const currentSession = await runtimeClient.session()
      if (seq !== connectSeqRef.current) return
      setRuntimeHealth(health)
      setLastHealthCheck(new Date().toLocaleTimeString())
      setSession(currentSession.state)
      commandSessionRef.current = currentSession.state
      setRuntimeState(isDegraded(health) ? 'DEGRADED' : 'CONNECTED')
      if (isDegraded(health)) {
        setRuntimeError('The runtime is connected but required capabilities are missing. Some features may not work.')
      }
    } catch (error) {
      if (seq !== connectSeqRef.current) return
      const clientError = error instanceof RuntimeClientError ? error : new RuntimeClientError('DISCONNECTED', 'The trusted local runtime could not be reached.', true)
      setRuntimeState('ERROR')
      setRuntimeErrorCode(clientError)
      setRuntimeError(userFriendlyError(clientError))
    }
  }

  const runRealCommand = async (trimmed: string, entryId: string, started: number) => {
    setProcessing(true)
    setProgress('Waiting for runtime')
    const abortController = new AbortController()
    commandAbortRef.current = abortController
    const sessionAtStart = commandSessionRef.current
    try {
      const result = await runtimeClient.command(trimmed, entryId, abortController.signal)
      if (commandSessionRef.current !== sessionAtStart) {
        addMessage('error', 'The session changed during this command. The result was discarded to prevent a stale response from overwriting the current state.', entryId)
        setHistory((current) => [{ id: entryId, command: trimmed, timestamp: new Date().toLocaleString(), status: 'unknown', duration: Math.round(performance.now() - started), detail: 'Session changed mid-command. Outcome unknown.', runtimeConfirmed: false }, ...current])
        return
      }
      result.progress.forEach((item) => { setProgress(item.stage); addMessage('progress', item.message, entryId) })
      const duration = Math.round(performance.now() - started)
      if (isVerifiedCompletion(result)) {
        setProgress('Completed')
        addMessage('agent', result.result!, entryId)
        setHistory((current) => [{ id: entryId, command: trimmed, timestamp: new Date().toLocaleString(), status: 'completed', duration, detail: 'Confirmed by the trusted local runtime.', runtimeConfirmed: true }, ...current])
      } else if (result.status === 'CANCELLED') {
        setProgress('Cancelled')
        addMessage('error', result.error?.message || 'The runtime cancelled this command. No successful execution was reported.', entryId)
        setHistory((current) => [{ id: entryId, command: trimmed, timestamp: new Date().toLocaleString(), status: 'cancelled', duration, detail: result.error?.message || 'Cancelled by the runtime.', runtimeConfirmed: true }, ...current])
      } else {
        setProgress('Failed')
        addMessage('error', result.error?.message || 'The runtime did not provide verified completion evidence.', entryId)
        setHistory((current) => [{ id: entryId, command: trimmed, timestamp: new Date().toLocaleString(), status: 'failed', duration, detail: result.error?.message || 'Unverified runtime result.', runtimeConfirmed: result.verified }, ...current])
      }
    } catch (error) {
      if (error instanceof RuntimeClientError && error.code === 'ABORTED') {
        setProgress('Cancelled')
        addMessage('error', 'Cancellation was requested locally. The runtime must confirm whether the command stopped.', entryId)
        setHistory((current) => [{ id: entryId, command: trimmed, timestamp: new Date().toLocaleString(), status: 'cancelled', duration: Math.round(performance.now() - started), detail: 'Cancelled by user. Runtime confirmation pending.', runtimeConfirmed: false }, ...current])
      } else if (error instanceof RuntimeClientError && (error.code === 'TIMEOUT' || error.code === 'DISCONNECTED')) {
        setProgress('Outcome unknown')
        addMessage('error', 'The runtime did not respond before the request timed out or was lost. The command outcome is unknown.', entryId)
        setHistory((current) => [{ id: entryId, command: trimmed, timestamp: new Date().toLocaleString(), status: 'unknown', duration: Math.round(performance.now() - started), detail: error.message, runtimeConfirmed: false }, ...current])
      } else {
        setRuntimeState('ERROR')
        const clientError = error instanceof RuntimeClientError ? error : new RuntimeClientError('DISCONNECTED', 'The trusted local runtime could not be reached.', true)
        setRuntimeErrorCode(clientError)
        setRuntimeError(userFriendlyError(clientError))
        setProgress('Runtime error')
        addMessage('error', userFriendlyError(clientError), entryId)
        setHistory((current) => [{ id: entryId, command: trimmed, timestamp: new Date().toLocaleString(), status: 'unknown', duration: Math.round(performance.now() - started), detail: error instanceof RuntimeClientError ? error.message : 'Runtime connection failed.', runtimeConfirmed: false }, ...current])
      }
    } finally { commandAbortRef.current = null; setProcessing(false) }
  }

  const runCommand = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = command.trim()
    if (!trimmed || processing) return
    const entryId = uid()
    const started = performance.now()
    addMessage('user', trimmed, entryId)
    setCommand('')
    const eligibility = checkEligibility('SUBMIT_COMMAND', { connectionState: runtimeState, capabilities, sessionState: session, hasPendingOperation: processing })
    if (!eligibility.eligible) {
      addMessage('error', eligibility.reason || 'This action is not available.', entryId)
      setProgress('Action blocked')
      return
    }
    void runRealCommand(trimmed, entryId, started)
  }

  const cancelCommand = () => {
    if (!processing) return
    commandAbortRef.current?.abort()
  }

  const handleControl = async (action: RuntimeControlAction) => {
    if (controlPending) return
    const gateAction: ActionType = action
    const eligibility = checkEligibility(gateAction, { connectionState: runtimeState, capabilities, sessionState: session, hasPendingOperation: controlPending !== null })
    if (!eligibility.eligible) {
      addMessage('error', eligibility.reason || 'This control action is not available.')
      return
    }
    if (stopsActiveExecution(action) && processing) commandAbortRef.current?.abort()
    const seq = ++controlSeqRef.current
    setControlPending(action)
    setControlState('SENDING')
    try {
      const result = await runtimeClient.control(action)
      if (seq !== controlSeqRef.current) return
      if (result.error) throw new RuntimeClientError(result.error.code, result.error.message, result.error.retryable)
      setSession(result.state)
      commandSessionRef.current = result.state
      setControlState('CONFIRMED')
    } catch (error) {
      if (seq !== controlSeqRef.current) return
      setControlState('FAILED')
      setRuntimeState('ERROR')
      const clientError = error instanceof RuntimeClientError ? error : new RuntimeClientError('DISCONNECTED', 'The runtime did not confirm the requested control change.', true)
      setRuntimeErrorCode(clientError)
      setRuntimeError(userFriendlyError(clientError))
      addMessage('error', userFriendlyError(clientError))
    } finally {
      if (seq === controlSeqRef.current) setControlPending(null)
    }
  }

  const refreshVoiceStatus = async () => {
    if (!isConnectionUsable(runtimeState)) { setVoiceStatus(allUnavailable); return }
    setVoiceBusy(true)
    try {
      const status = await voiceClient.getStatus()
      setVoiceStatus(status)
      setVoiceError(null)
    } catch (error) {
      setVoiceError(error instanceof VoiceClientError ? error.message : 'Voice status could not be read from the runtime.')
      setVoiceStatus(allUnavailable)
    } finally { setVoiceBusy(false) }
  }

  useEffect(() => { void refreshVoiceStatus() }, [runtimeState])

  const activateVoice = async () => {
    const eligibility = checkEligibility('VOICE_ACTIVATE', { connectionState: runtimeState, capabilities, sessionState: session, hasPendingOperation: voiceBusy })
    if (!eligibility.eligible) { setVoiceError(eligibility.reason || 'Voice activation is not available.'); return }
    setVoiceBusy(true)
    try {
      const result = await voiceClient.activate()
      if (result.error) setVoiceError(result.error)
      if (result.microphone === 'DENIED') setVoiceError('The runtime reported that microphone permission was denied.')
      await refreshVoiceStatus()
    } catch (error) {
      setVoiceError(error instanceof VoiceClientError ? error.message : 'Voice activation failed.')
    } finally { setVoiceBusy(false) }
  }

  const deactivateVoice = async () => {
    const eligibility = checkEligibility('VOICE_DEACTIVATE', { connectionState: runtimeState, capabilities, sessionState: session, hasPendingOperation: voiceBusy })
    if (!eligibility.eligible) { setVoiceError(eligibility.reason || 'Voice deactivation is not available.'); return }
    setVoiceBusy(true)
    try {
      await voiceClient.deactivate()
      await refreshVoiceStatus()
    } catch (error) {
      setVoiceError(error instanceof VoiceClientError ? error.message : 'Voice deactivation failed.')
    } finally { setVoiceBusy(false) }
  }

  const stopSpeaking = async () => {
    const eligibility = checkEligibility('VOICE_STOP_SPEAKING', { connectionState: runtimeState, capabilities, sessionState: session, hasPendingOperation: voiceBusy })
    if (!eligibility.eligible) { setVoiceError(eligibility.reason || 'Stop speaking is not available.'); return }
    setVoiceBusy(true)
    try { await voiceClient.stopSpeaking(); await refreshVoiceStatus() } catch (error) { setVoiceError(error instanceof VoiceClientError ? error.message : 'Stop speaking failed.') } finally { setVoiceBusy(false) }
  }

  if (!profile || onboardingStep < 4) return <Onboarding step={onboardingStep} setStep={setOnboardingStep} draft={draftProfile} setDraft={setDraftProfile} saveProfile={saveProfile} />

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><img src="/assets/images/AGENT_LOGO_1.jpeg" alt="AGENT" /><div><strong>AGENT</strong><span>LOCAL-FIRST OPERATOR</span></div></div>
      <button className="new-conversation" onClick={() => { setPage('workspace'); setMessages(initialMessages); setProgress('Idle') }}><Icon name="plus" /> New conversation</button>
      <nav className="nav-list" aria-label="Primary navigation">
        <NavItem icon="grid" label="Workspace" active={page === 'workspace'} onClick={() => setPage('workspace')} />
        <NavItem icon="clock" label="Command history" active={page === 'history'} onClick={() => setPage('history')} />
        <NavItem icon="mic" label="Voice" active={page === 'voice'} onClick={() => setPage('voice')} />
        <NavItem icon="shield" label="Diagnostics" active={page === 'diagnostics'} onClick={() => setPage('diagnostics')} />
        <NavItem icon="settings" label="Settings" active={page === 'settings'} onClick={() => setPage('settings')} />
      </nav>
      <div className="sidebar-bottom"><div className="profile-mini"><span className="avatar">{profile.name.slice(0, 1).toUpperCase()}</span><div><strong>{profile.name}</strong><span>Local profile</span></div><button className="icon-button" onClick={() => setPage('settings')} aria-label="Open profile settings"><Icon name="settings" /></button></div></div>
    </aside>
    <main className="main-content">
      <header className="topbar"><div><span className="eyebrow">{page === 'workspace' ? 'COMMAND CENTER' : 'AGENT / ' + page.toUpperCase()}</span><h1>{pageTitle}</h1></div><div className="topbar-status"><span className="demo-pill"><span className={`status-dot ${runtimeState === 'CONNECTED' ? 'green' : 'amber'}`} /> REAL RUNTIME ONLY</span><span className="runtime-status"><span className={`status-dot ${runtimeState === 'CONNECTED' ? 'green' : runtimeState === 'DEGRADED' ? 'amber' : runtimeState === 'ERROR' ? 'red' : runtimeState === 'CONNECTING' ? 'amber' : 'slate'}`} /> Runtime {runtimeState.toLowerCase()}</span></div></header>
      {page === 'workspace' && <Workspace runtimeState={runtimeState} runtimeError={runtimeError} runtimeHealth={runtimeHealth} connectRuntime={connectRuntime} session={session} sessionLabel={sessionLabel} messages={messages} command={command} setCommand={setCommand} runCommand={runCommand} processing={processing} progress={progress} cancelCommand={cancelCommand} canAct={canAct} onControl={handleControl} controlPending={controlPending} controlState={controlState} capabilities={capabilities} messageListRef={messageListRef} />}
      {page === 'history' && <History history={filteredHistory} filter={historyFilter} setFilter={setHistoryFilter} clear={() => { setHistory([]); localStorage.removeItem('agent-history') }} />}
      {page === 'voice' && <VoicePage runtimeState={runtimeState} voiceStatus={voiceStatus} voiceError={voiceError} voiceBusy={voiceBusy} activate={activateVoice} deactivate={deactivateVoice} stopSpeaking={stopSpeaking} refresh={refreshVoiceStatus} capabilities={capabilities} />}
      {page === 'diagnostics' && <DiagnosticsPage runtimeState={runtimeState} runtimeError={runtimeError} runtimeErrorCode={runtimeErrorCode} runtimeHealth={runtimeHealth} session={session} lastHealthCheck={lastHealthCheck} connectRuntime={connectRuntime} />}
      {page === 'settings' && <Settings profile={profile} appearance={appearance} setAppearance={setAppearance} historyCount={history.length} reset={resetDemo} />}
    </main>
  </div>
}

function NavItem({ icon, label, active, onClick }: { icon: string; label: string; active: boolean; onClick: () => void }) { return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}><Icon name={icon} /><span>{label}</span>{active && <span className="nav-active" />}</button> }

function Onboarding({ step, setStep, draft, setDraft, saveProfile }: { step: number; setStep: (step: number) => void; draft: Profile; setDraft: (profile: Profile) => void; saveProfile: (event: FormEvent) => void }) {
  return <div className="onboarding"><div className="onboarding-art"><img src="/assets/images/AGENT_LOGO_2.jpeg" alt="AGENT mark" /><span className="art-label">PRIVATE BY DESIGN</span></div><div className="onboarding-panel"><div className="brand compact"><img src="/assets/images/AGENT_LOGO_1.jpeg" alt="AGENT" /><div><strong>AGENT</strong><span>LOCAL-FIRST OPERATOR</span></div></div><div className="step-indicator"><span className={step >= 1 ? 'current' : ''}>01</span><i /><span className={step >= 2 ? 'current' : ''}>02</span><i /><span className={step >= 3 ? 'current' : ''}>03</span><i /><span className={step >= 4 ? 'current' : ''}>04</span></div>{step === 1 && <div className="onboarding-copy"><span className="eyebrow">A calmer way to operate</span><h1>Command your computer.<br /><em>Keep control.</em></h1><p>AGENT is designed to understand natural-language instructions and help you operate your computer through explicit, observable sessions.</p><div className="privacy-note"><Icon name="shield" /><span><strong>Local-first privacy</strong><br />This prototype keeps your profile and command history in this browser. No cloud account is required.</span></div><button className="primary-button wide" onClick={() => setStep(2)}>Create local profile <Icon name="arrow" /></button><button className="text-button" onClick={() => setStep(2)}>Continue</button></div>}{step === 2 && <form className="onboarding-copy" onSubmit={saveProfile}><span className="eyebrow">Your local workspace</span><h1>Make it yours.</h1><p>A display name helps AGENT address you. No email, cloud account, or unnecessary personal information is needed.</p><label>Display name<input autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Alex" required /></label><label>Preferred form of address <span className="optional">Optional</span><input value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} placeholder="e.g. Alex, Captain, or leave blank" /></label><button className="primary-button wide" type="submit">Continue <Icon name="arrow" /></button></form>}{step === 3 && <div className="onboarding-copy"><span className="eyebrow">Before you begin</span><h1>Control stays with you.</h1><p>This browser is not connected to Windows, Ollama, or a microphone until the trusted runtime is connected.</p><div className="principle-list"><div><span>01</span><strong>Sessions start inactive</strong><p>TAKE OVER is always an explicit action.</p></div><div><span>02</span><strong>Stop means stop</strong><p>Pause, stop, and release have different outcomes.</p></div><div><span>03</span><strong>Voice is opt-in</strong><p>No microphone is accessed without your action.</p></div></div><button className="primary-button wide" onClick={() => setStep(4)}>I understand <Icon name="arrow" /></button></div>}{step === 4 && <div className="onboarding-copy ready"><span className="ready-mark"><Icon name="check" /></span><span className="eyebrow">Workspace ready</span><h1>Welcome to AGENT{draft.name ? `, ${draft.name}` : ''}.</h1><p>Your local workspace is ready. Connect the trusted runtime from the Workspace before requesting computer control.</p><button className="primary-button wide" onClick={() => setStep(4)}>Enter workspace <Icon name="arrow" /></button></div>}</div></div>
}

function Workspace({ runtimeState, runtimeError, runtimeHealth, connectRuntime, session, sessionLabel, messages, command, setCommand, runCommand, processing, progress, cancelCommand, canAct, onControl, controlPending, controlState, capabilities, messageListRef }: { runtimeState: RuntimeConnectionState; runtimeError: string | null; runtimeHealth: RuntimeHealth | null; connectRuntime: () => void; session: SessionState; sessionLabel: string; messages: Message[]; command: string; setCommand: (value: string) => void; runCommand: (event: FormEvent) => void; processing: boolean; progress: string; cancelCommand: () => void; canAct: boolean; onControl: (action: RuntimeControlAction) => void; controlPending: RuntimeControlAction | null; controlState: ControlRequestState; capabilities: string[]; messageListRef: RefObject<HTMLDivElement | null> }) {
  const handleKey = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }
  return <div className="workspace-grid"><section className="conversation-panel"><div className="conversation-heading"><div><span className="eyebrow">LIVE CONVERSATION</span><h2>What would you like to do?</h2></div><span className="session-chip"><span className={`status-dot ${session === 'ACTIVE' ? 'green' : session === 'PAUSED' ? 'amber' : 'slate'}`} /> {sessionLabel}</span></div><div className="message-list" ref={messageListRef} aria-live="polite" aria-label="Conversation messages">{messages.map((message) => <div className={`message-row ${message.kind}`} key={message.id}><div className="message-avatar" aria-hidden="true">{message.kind === 'user' ? 'Y' : message.kind === 'error' ? '!' : 'A'}</div><div className="message-body"><div className="message-meta"><strong>{message.kind === 'user' ? 'You' : message.kind === 'error' ? 'Action blocked' : message.kind === 'progress' ? 'Activity' : 'AGENT'}</strong><span>{message.time}</span></div><p>{message.text}</p></div></div>)}</div><form className="composer" onSubmit={runCommand}><textarea value={command} onChange={(e) => setCommand(e.target.value)} onKeyDown={handleKey} disabled={processing} placeholder="Tell AGENT what you want to do..." aria-label="Command input" /><div className="composer-footer"><span>Enter to send <i>•</i> Shift + Enter for a new line</span>{processing ? <button type="button" className="cancel-button" onClick={cancelCommand}><Icon name="close" /> Cancel operation</button> : <button type="submit" className="send-button" disabled={!command.trim()}><Icon name="arrow" /> Send command</button>}</div></form></section><aside className="workspace-rail"><ControlPanel runtimeState={runtimeState} session={session} onControl={onControl} pending={controlPending} controlState={controlState} capabilities={capabilities} /><div className="status-card"><div className="card-heading"><span className="icon-box"><Icon name="shield" /></span><div><span className="eyebrow">LOCAL RUNTIME</span><h3>{runtimeState}</h3></div></div><div className="status-line"><span className={`status-dot ${runtimeState === 'CONNECTED' ? 'green' : runtimeState === 'DEGRADED' ? 'amber' : runtimeState === 'ERROR' ? 'red' : runtimeState === 'CONNECTING' ? 'amber' : 'slate'}`} /><strong>{runtimeState === 'CONNECTED' ? 'Trusted runtime connected' : runtimeState === 'DEGRADED' ? 'Connected with missing capabilities' : runtimeState === 'CONNECTING' ? 'Connecting…' : runtimeState === 'ERROR' ? 'Connection error' : 'Disconnected'}</strong></div><p>{runtimeError || (runtimeState === 'CONNECTED' ? 'Real commands use responses from the trusted Windows runtime.' : runtimeState === 'DEGRADED' ? 'The runtime responded but some required capabilities are unavailable.' : 'No automatic localhost request is made. Connect only through the explicit action below.')}</p>{(runtimeState === 'CONNECTED' || runtimeState === 'DEGRADED') && runtimeHealth ? <><div className="status-detail"><span>Version</span><strong>{runtimeHealth.version || 'Unknown'}</strong></div><div className="status-detail"><span>Capabilities</span><strong>{runtimeHealth.capabilities.length}</strong></div>{runtimeHealth.aiProvider && <div className="status-detail"><span>AI provider</span><strong>{runtimeHealth.aiProvider.name}{runtimeHealth.aiProvider.model ? ` / ${runtimeHealth.aiProvider.model}` : ''}</strong></div>}</> : <button className="outline-button" onClick={connectRuntime} disabled={runtimeState === 'CONNECTING'}>{runtimeState === 'ERROR' ? 'Retry connection' : 'Connect runtime'}</button>}</div><div className="status-card compact-card"><span className="eyebrow">CURRENT ACTIVITY</span><div className="activity-row"><span className={`activity-pulse ${processing ? 'running' : ''}`} /><strong>{progress}</strong></div>{processing && <div className="progress-track"><span /></div>}<p>{(runtimeState === 'CONNECTED' || runtimeState === 'DEGRADED') && canAct ? 'The trusted runtime can receive scoped commands.' : 'Connect the runtime and take over control to enable commands.'}</p></div></aside></div>
}

function ControlPanel({ runtimeState, session, onControl, pending, controlState, capabilities }: { runtimeState: RuntimeConnectionState; session: SessionState; onControl: (action: RuntimeControlAction) => void; pending: RuntimeControlAction | null; controlState: ControlRequestState; capabilities: string[] }) {
  const active = session === 'ACTIVE'
  const paused = session === 'PAUSED'
  const busy = pending !== null
  const usable = isConnectionUsable(runtimeState)
  const hasSessionCap = capabilities.includes('session')
  const controlsDisabled = !usable || !hasSessionCap
  const sending = controlState === 'SENDING'
  const statusLabel = sending ? 'Sending request…' : controlState === 'CONFIRMED' ? 'Confirmed by runtime' : controlState === 'FAILED' ? 'Request failed' : ''
  const blockReason = !usable ? 'Connect the trusted runtime before requesting computer control.' : !hasSessionCap ? 'The runtime did not report the required "session" capability.' : ''
  return <div className={`control-card ${active ? 'is-active' : ''}`}><div className="control-card-top"><div><span className="eyebrow">CONTROL SESSION · RUNTIME</span><h3>{session}</h3></div><span className={`control-light ${active ? 'on' : ''}`} /></div><p>{active ? 'The trusted runtime confirmed active control.' : paused ? 'Actions are paused. Resume or release through the runtime.' : blockReason || 'No computer actions can run until the runtime confirms takeover.'}</p>{statusLabel && <div className={`control-status-label ${controlState === 'SENDING' ? 'sending' : controlState === 'FAILED' ? 'failed' : 'confirmed'}`}>{statusLabel}</div>}<div className="control-actions"><button className="takeover" disabled={active || busy || controlsDisabled} onClick={() => onControl('TAKE_OVER')}><Icon name="play" /> {paused ? 'RESUME' : 'TAKE OVER'}</button><div className="secondary-actions"><button disabled={!active || busy || controlsDisabled} onClick={() => onControl('PAUSE')}><Icon name="pause" /> PAUSE</button><button disabled={(!active && !paused) || busy || controlsDisabled} onClick={() => onControl('STOP')}><Icon name="stop" /> STOP</button><button disabled={session === 'INACTIVE' || session === 'RELEASED' || busy || controlsDisabled} onClick={() => onControl('RELEASE_CONTROL')}><Icon name="close" /> RELEASE</button></div></div></div>
}

function History({ history, filter, setFilter, clear }: { history: HistoryEntry[]; filter: 'all' | EntryStatus; setFilter: (filter: 'all' | EntryStatus) => void; clear: () => void }) { return <div className="page-section"><div className="section-heading"><div><span className="eyebrow">AUDITABLE ACTIVITY</span><h2>Command history</h2><p>Each entry records the command, its outcome, and whether the runtime confirmed the result.</p></div><button className="outline-button" onClick={clear} disabled={!history.length}>Clear history</button></div><div className="filter-row">{(['all', 'completed', 'failed', 'cancelled', 'unknown'] as const).map((item) => <button className={filter === item ? 'selected' : ''} key={item} onClick={() => setFilter(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</div><div className="history-list">{history.length === 0 ? <EmptyState title="No commands yet" text="Completed, failed, cancelled, or unknown-outcome commands will appear here." /> : history.map((entry) => <div className="history-item" key={entry.id}><div className={`history-status ${entry.status}`}><Icon name={entry.status === 'completed' ? 'check' : entry.status === 'cancelled' ? 'pause' : entry.status === 'unknown' ? 'clock' : 'close'} /></div><div className="history-main"><strong>{entry.command}</strong><span>{entry.timestamp} · {entry.duration} ms · {entry.runtimeConfirmed ? 'Runtime-confirmed' : 'Not runtime-confirmed'}</span><p>{entry.detail}</p></div><span className={`result-label ${entry.status}`}>{entry.status}</span></div>)}</div></div> }

function VoicePage({ runtimeState, voiceStatus, voiceError, voiceBusy, activate, deactivate, stopSpeaking, refresh, capabilities }: { runtimeState: RuntimeConnectionState; voiceStatus: VoiceStatus; voiceError: string | null; voiceBusy: boolean; activate: () => void; deactivate: () => void; stopSpeaking: () => void; refresh: () => void; capabilities: string[] }) { const connected = isConnectionUsable(runtimeState); const hasVoiceCap = capabilities.includes('voice'); const voiceAvailable = connected && hasVoiceCap; const wakeListening = voiceStatus.wakeWord.status === 'ACTIVE' && voiceStatus.wakeWord.listening && voiceStatus.wakeWord.confirmedByRuntime; const ttsSpeaking = voiceStatus.tts.status === 'ACTIVE' && voiceStatus.tts.speaking && voiceStatus.tts.confirmedByRuntime; const canActivate = voiceAvailable && !voiceBusy && (voiceStatus.wakeWord.status === 'READY' || voiceStatus.wakeWord.status === 'ACTIVE'); const canDeactivate = voiceAvailable && !voiceBusy && wakeListening; return <div className="page-section voice-page"><div className="section-heading"><div><span className="eyebrow">LOCAL VOICE CAPABILITIES</span><h2>Voice interface</h2><p>Each capability shows status confirmed by the trusted runtime. No microphone is activated on page load, and no cloud speech service is used.</p></div><span className={`large-status ${wakeListening ? 'active' : ''}`}><span className={`status-dot ${wakeListening ? 'green' : 'slate'}`} /> {wakeListening ? 'Listening for “AGENT”' : 'Microphone off'}</span></div>{voiceError && <div className="voice-notice">{voiceError}</div>}<div className="voice-grid"><div className="voice-hero"><div className={`mic-orb ${wakeListening ? 'listening' : ''}`}><Icon name="mic" /></div><span className="eyebrow">{wakeListening ? 'LISTENING' : 'MICROPHONE OFF'}</span><h3>{wakeListening ? 'Wake-word detection is active.' : 'Voice waits for your permission.'}</h3><p>{voiceAvailable ? 'Activation requests wake-word detection through the trusted runtime. The microphone only captures when the runtime confirms listening.' : !connected ? 'Connect the trusted runtime first, then activate voice.' : 'The runtime did not report the "voice" capability. Voice actions are unavailable.'}</p>{canDeactivate ? <button className="outline-button danger" onClick={deactivate}><Icon name="stop" /> Deactivate</button> : <button className="primary-button" disabled={!canActivate} onClick={activate}><Icon name="mic" /> Activate voice</button>}{voiceBusy && <span className="voice-notice">Runtime operation in progress…</span>}<button className="outline-button voice-refresh" onClick={refresh} disabled={!voiceAvailable || voiceBusy}>Refresh status</button></div><div className="voice-checklist"><VoiceCapabilityCard title="Wake-word detection" status={voiceStatus.wakeWord.status} confirmed={voiceStatus.wakeWord.confirmedByRuntime} detail={voiceStatus.wakeWord.detail} extra={<><StatusRow label="Wake phrase" value={voiceStatus.wakeWord.phrase || 'Not set'} tone="slate" /><StatusRow label="Microphone" value={voiceStatus.wakeWord.microphone} tone={voiceStatus.wakeWord.microphone === 'GRANTED' ? 'green' : voiceStatus.wakeWord.microphone === 'DENIED' ? 'red' : 'slate'} /></>} /><VoiceCapabilityCard title="Local speech recognition" status={voiceStatus.recognition.status} confirmed={voiceStatus.recognition.confirmedByRuntime} detail={voiceStatus.recognition.detail} extra={<><StatusRow label="Engine" value={voiceStatus.recognition.engineName || 'None'} tone="slate" /><StatusRow label="Microphone" value={voiceStatus.recognition.microphone} tone={voiceStatus.recognition.microphone === 'GRANTED' ? 'green' : voiceStatus.recognition.microphone === 'DENIED' ? 'red' : 'slate'} /></>} /><VoiceCapabilityCard title="Speaker authentication" status={voiceStatus.speakerAuth.status} confirmed={voiceStatus.speakerAuth.confirmedByRuntime} detail={voiceStatus.speakerAuth.detail} extra={<StatusRow label="Engine" value={voiceStatus.speakerAuth.engineName || 'None'} tone="slate" />} /><VoiceCapabilityCard title="Local text-to-speech" status={voiceStatus.tts.status} confirmed={voiceStatus.tts.confirmedByRuntime} detail={voiceStatus.tts.detail} extra={<><StatusRow label="Engine" value={voiceStatus.tts.engineName || 'None'} tone="slate" /><StatusRow label="Speaking" value={ttsSpeaking ? 'Yes' : 'No'} tone={ttsSpeaking ? 'green' : 'slate'} />{ttsSpeaking && <button className="outline-button danger voice-stop" onClick={stopSpeaking} disabled={voiceBusy}>Stop speaking</button>}</>} /><div className="honest-note"><strong>Privacy boundary</strong><p>No cloud speech APIs, automatic model downloads, or microphone activation on page load. Voice commands pass through the same trusted permissions, HumanControl, and verification as text commands. STOP immediately halts further actions regardless of voice state.</p></div></div></div></div> }

function VoiceCapabilityCard({ title, status, confirmed, detail, extra }: { title: string; status: VoiceCapabilityStatus; confirmed: boolean; detail: string | null; extra: ReactNode }) { const tone = status === 'ACTIVE' ? 'green' : status === 'READY' ? 'green' : status === 'ERROR' ? 'red' : 'amber'; return <div className="voice-capability-card"><div className="capability-header"><span className={`status-dot ${tone}`} /><strong>{title}</strong><span className="capability-badge">{status}</span></div><div className="capability-confirmed">{confirmed ? 'Confirmed by runtime' : 'Not confirmed by runtime'}</div>{detail && <p className="capability-detail">{detail}</p>}{extra}</div> }

function StatusRow({ label, value, tone }: { label: string; value: string; tone: string }) { return <div className="status-row"><span><span className={`status-dot ${tone}`} />{label}</span><strong>{value}</strong></div> }

function Settings({ profile, appearance, setAppearance, historyCount, reset }: { profile: Profile; appearance: 'midnight' | 'soft'; setAppearance: (value: 'midnight' | 'soft') => void; historyCount: number; reset: () => void }) { return <div className="page-section settings-page"><div className="section-heading"><div><span className="eyebrow">LOCAL PREFERENCES</span><h2>Settings</h2><p>Small, functional controls for this prototype. Sensitive credentials are never stored here.</p></div></div><div className="settings-grid"><div className="settings-card"><span className="eyebrow">PROFILE</span><div className="profile-large"><span className="avatar">{profile.name.slice(0, 1).toUpperCase()}</span><div><h3>{profile.name}</h3><p>{profile.address || 'No preferred form of address'}</p></div></div><div className="setting-line"><span>Storage</span><strong>Browser only</strong></div><div className="setting-line"><span>Authentication</span><strong>Not provided</strong></div></div><div className="settings-card"><span className="eyebrow">APPEARANCE</span><h3>Interface tone</h3><p>Choose a comfortable contrast treatment for the workspace.</p><div className="segmented"><button className={appearance === 'midnight' ? 'selected' : ''} onClick={() => setAppearance('midnight')}>Midnight</button><button className={appearance === 'soft' ? 'selected' : ''} onClick={() => setAppearance('soft')}>Soft slate</button></div><span className="eyebrow setting-eyebrow">LOCAL DATA</span><div className="setting-line"><span>Saved history</span><strong>{historyCount} {historyCount === 1 ? 'entry' : 'entries'}</strong></div><button className="outline-button danger" onClick={reset}>Reset prototype</button></div></div></div> }

function DiagnosticsPage({ runtimeState, runtimeError, runtimeErrorCode, runtimeHealth, session, lastHealthCheck, connectRuntime }: { runtimeState: RuntimeConnectionState; runtimeError: string | null; runtimeErrorCode: RuntimeClientError | null; runtimeHealth: RuntimeHealth | null; session: SessionState; lastHealthCheck: string | null; connectRuntime: () => void }) {
  const entries = useMemo(() => buildDiagnostics(runtimeState, runtimeHealth, session, lastHealthCheck, runtimeErrorCode), [runtimeState, runtimeHealth, session, lastHealthCheck, runtimeErrorCode])
  return <div className="page-section diagnostics-page"><div className="section-heading"><div><span className="eyebrow">RUNTIME HEALTH</span><h2>Runtime diagnostics</h2><p>Connection state, capability availability, and error categories reported by the trusted local runtime. No values are fabricated.</p></div>{(runtimeState === 'DISCONNECTED' || runtimeState === 'ERROR') && <button className="outline-button" onClick={connectRuntime}>Connect runtime</button>}</div>{runtimeError && <div className="diag-error-banner"><div><strong>{runtimeErrorCode ? categorizeError(runtimeErrorCode).replace(/_/g, ' ') : 'Error'}</strong><p>{runtimeError}</p></div>{runtimeErrorCode && <span className="diag-tech-detail">{runtimeErrorCode.code}</span>}</div>}<div className="diag-grid">{entries.map((entry) => <div className="diag-row" key={entry.label}><span className={`status-dot ${entry.tone}`} /><div className="diag-row-content"><span className="diag-label">{entry.label}</span><strong className={entry.confirmed ? '' : 'unconfirmed'}>{entry.value}</strong></div>{entry.confirmed ? <span className="diag-badge confirmed">Confirmed</span> : <span className="diag-badge unconfirmed">Unknown</span>}</div>)}</div></div>
}

function EmptyState({ title, text }: { title: string; text: string }) { return <div className="empty-state"><span className="empty-icon"><Icon name="clock" /></span><h3>{title}</h3><p>{text}</p></div> }

export default App

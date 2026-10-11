# AGENT Runtime API Contract

This document defines the HTTP endpoints the frontend expects from the trusted
local AGENT Python runtime. The frontend talks to these via same-origin
relative paths (`/api/runtime/*`). During development, Vite proxies these to
`http://127.0.0.1:8787`.

## Binding and security requirements

- Bind **only** to `127.0.0.1` (loopback). Never `0.0.0.0` or a LAN IP.
- Reject requests with `Origin` headers that do not match the allowed
  browser origin (the Vite dev server or the deployed frontend origin).
- Return `403` for any cross-origin request on state-changing endpoints.
- Validate every request body against the schemas below. Return `400` for
  malformed or oversized payloads (max 64 KB body, max 2000 char command).
- Enforce request timeouts (recommend 10 s for commands, 30 s for voice).
- Never log command text or transcripts at INFO level.
- Never expose Ollama directly to the browser. All LLM interaction stays
  server-side within the trusted runtime.
- Fail closed: if authorization, session state, or runtime availability
  cannot be verified, return `503` with a retryable error.

## Content type

All requests and responses use `application/json`.

---

## GET /api/runtime/health

Returns runtime identity and capability list.

**Response 200:**
```json
{
  "runtime": "AGENT",
  "version": "0.1.0",
  "capabilities": ["session", "commands", "voice"],
  "timestamp": "2026-10-11T12:00:00Z",
  "aiProvider": {
    "name": "Ollama",
    "model": "llama3",
    "status": "READY"
  }
}
```

- `runtime` must be the string `"AGENT"`.
- `version` is a string or `null`.
- `capabilities` is an array of strings. Required capabilities are
  `"session"` and `"commands"`; `"voice"` is optional. If required
  capabilities are missing, the frontend marks the connection as
  `DEGRADED`.
- `timestamp` is an ISO-8601 string.
- `aiProvider` is optional. When present, `name` is a non-empty string,
  `model` is a string or `null`, and `status` is one of `"READY"`,
  `"UNAVAILABLE"`, `"ERROR"`. When absent, the frontend displays
  "Not reported".

---

## GET /api/runtime/session

Returns the current control-session state.

**Response 200:**
```json
{
  "state": "INACTIVE",
  "sessionId": null,
  "timestamp": "2026-10-11T12:00:00Z"
}
```

- `state` must be one of: `"INACTIVE"`, `"ACTIVE"`, `"PAUSED"`, `"STOPPED"`, `"RELEASED"`.
- `sessionId` is a string or `null`.

---

## POST /api/runtime/session/control

Requests a control-session transition. The runtime is the sole authority and
may reject or override the requested action per its precedence rules
(STOP > TAKE_CONTROL > PAUSE).

**Request body:**
```json
{ "action": "TAKE_OVER" }
```

- `action` must be one of: `"TAKE_OVER"`, `"PAUSE"`, `"STOP"`, `"RELEASE_CONTROL"`.

**Response 200:**
```json
{
  "action": "TAKE_OVER",
  "state": "ACTIVE",
  "sessionId": "session-uuid",
  "timestamp": "2026-10-11T12:00:00Z",
  "error": null
}
```

- `error` is `null` on success, or `{ "code": string, "message": string, "retryable": boolean }` on failure.

**Response 403** if the session state does not allow the transition.
**Response 400** if `action` is missing or invalid.

---

## POST /api/runtime/commands

Submits a natural-language command for scoped execution by the trusted
runtime. The runtime enforces HumanControl, PermissionManager, ComputerControl,
and Verifier. The frontend never executes commands itself.

**Request body:**
```json
{
  "command": "Open Notepad",
  "clientCommandId": "client-uuid"
}
```

- `command` is a non-empty string (max 2000 characters).
- `clientCommandId` is a non-empty string.

**Response 200:**
```json
{
  "commandId": "runtime-uuid",
  "status": "COMPLETED",
  "sessionState": "ACTIVE",
  "progress": [
    { "commandId": "runtime-uuid", "stage": "Parsing", "message": "Interpreting command", "timestamp": "..." }
  ],
  "result": "Notepad was opened and verified.",
  "verified": true,
  "error": null,
  "startedAt": "2026-10-11T12:00:00Z",
  "finishedAt": "2026-10-11T12:00:01Z"
}
```

- `status` must be one of: `"ACCEPTED"`, `"RUNNING"`, `"COMPLETED"`, `"FAILED"`, `"CANCELLED"`.
- `sessionState` must be a valid session state.
- `progress` is an array of progress entries.
- `result` is a string or `null`. The frontend only treats a command as
  successful when `status === "COMPLETED" && verified === true && result` is
  non-empty.
- `verified` is a boolean. Must be `false` if the runtime cannot provide
  verification evidence.
- `error` is `null` or an error object.

**Response 403** if the session is not ACTIVE.
**Response 400** if the command is empty or too long.

---

## POST /api/runtime/commands/{commandId}/cancel

Requests cancellation of an in-progress command.

**Response 200:** Same schema as POST /commands, with `status: "CANCELLED"`.

**Response 404** if the command is not found.

---

## GET /api/runtime/voice/status

Returns the status of all four voice capabilities as confirmed by the runtime.

**Response 200:**
```json
{
  "wakeWord": {
    "status": "UNAVAILABLE",
    "phrase": "AGENT",
    "listening": false,
    "microphone": "NOT_REQUESTED",
    "confirmedByRuntime": false,
    "detail": "No wake-word detector is connected."
  },
  "recognition": {
    "status": "UNAVAILABLE",
    "engineName": null,
    "microphone": "NOT_REQUESTED",
    "confirmedByRuntime": false,
    "detail": "No local speech-recognition engine is connected."
  },
  "speakerAuth": {
    "status": "UNAVAILABLE",
    "engineName": null,
    "confirmedByRuntime": false,
    "detail": "No trusted speaker-verification engine is connected."
  },
  "tts": {
    "status": "UNAVAILABLE",
    "engineName": null,
    "speaking": false,
    "confirmedByRuntime": false,
    "detail": "No local text-to-speech engine is connected."
  },
  "timestamp": "2026-10-11T12:00:00Z"
}
```

Capability `status` values: `"NOT_CONFIGURED"`, `"UNAVAILABLE"`, `"READY"`, `"ACTIVE"`, `"ERROR"`.

Microphone `microphone` values: `"NOT_REQUESTED"`, `"GRANTED"`, `"DENIED"`, `"ERROR"`.

Until actual engines are connected, all four capabilities must report
`UNAVAILABLE` with `confirmedByRuntime: false`.

---

## POST /api/runtime/voice/activate

Requests the runtime to activate wake-word detection (opt-in).

**Response 200:**
```json
{
  "activated": true,
  "listening": true,
  "microphone": "GRANTED",
  "error": null,
  "timestamp": "..."
}
```

---

## POST /api/runtime/voice/deactivate

Requests the runtime to stop wake-word detection.

**Response 200:** Same schema as activate.

---

## POST /api/runtime/voice/recognize

Requests one-shot local speech recognition.

**Request body:**
```json
{ "timeoutMs": 5000 }
```

**Response 200:**
```json
{
  "requestId": "req-uuid",
  "transcript": "open notepad",
  "status": "COMPLETED",
  "error": null,
  "timestamp": "..."
}
```

`status` values: `"COMPLETED"`, `"TIMEOUT"`, `"ERROR"`, `"CANCELLED"`.

---

## POST /api/runtime/voice/speak

Requests local text-to-speech.

**Request body:**
```json
{ "text": "Command completed." }
```

**Response 200:**
```json
{
  "requestId": "req-uuid",
  "status": "STARTED",
  "error": null,
  "timestamp": "..."
}
```

`status` values: `"STARTED"`, `"COMPLETED"`, `"STOPPED"`, `"ERROR"`.

---

## POST /api/runtime/voice/speak/stop

Halts any in-progress text-to-speech.

**Response 200:** Same schema as speak, with `status: "STOPPED"`.

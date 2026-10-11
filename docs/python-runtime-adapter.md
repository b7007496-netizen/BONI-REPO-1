# AGENT Python Runtime Adapter Specification

This document describes the adapter that must be implemented in the existing
Windows AGENT Python project to serve the frontend's runtime API contract.

## What exists in this Bolt project

- **Frontend runtime client**: `src/runtime/client.ts` — typed client for
  health, session, control, commands, and cancel endpoints.
- **Frontend voice client**: `src/runtime/voice-client.ts` — typed client for
  voice status, activate, deactivate, recognize, speak, and stop.
- **API contract**: `docs/runtime-api-contract.md` — the exact endpoint
  schemas the frontend expects.
- **Dev proxy**: `vite.config.ts` proxies `/api/runtime/*` to
  `http://127.0.0.1:8787` during development.

## What does NOT exist in this Bolt project

- No Python source code. The existing AGENT Windows Python application lives
  in a separate repository.
- No actual computer-control execution. The frontend never executes commands.
- No voice engines. All four capabilities report UNAVAILABLE.

## Adapter requirements for the Windows AGENT project

### 1. HTTP server (FastAPI / aiohttp / Flask)

Create a lightweight HTTP server that:

- Binds to `127.0.0.1:8787` only.
- Implements every endpoint in `docs/runtime-api-contract.md`.
- Validates request bodies against the schemas.
- Returns `400` for malformed input, `403` for unauthorized transitions,
  `503` when the runtime is unavailable.

### 2. Bridge to existing AGENT components

The adapter must delegate to the existing Python components — it must not
reimplement them:

| Endpoint | Delegates to |
|---|---|
| `GET /health` | Report AGENT version + capability list |
| `GET /session` | Read current session state from `HumanControl` |
| `POST /session/control` | Call `HumanControl.take_over()` / `.pause()` / `.stop()` / `.release()` |
| `POST /commands` | Pass through `PermissionManager.check()`, then `ComputerControl.execute()`, then `Verifier.verify()`, then `Reporter.report()` |
| `POST /commands/{id}/cancel` | Call `HumanControl.cancel_command(id)` |
| `GET /voice/status` | Query each voice adapter for engine availability and microphone state |
| `POST /voice/activate` | Start wake-word detector (opt-in, requires microphone permission) |
| `POST /voice/deactivate` | Stop wake-word detector |
| `POST /voice/recognize` | One-shot recognition through the local speech engine |
| `POST /voice/speak` | Queue text through the local TTS engine |
| `POST /voice/speak/stop` | Stop current TTS playback |

### 3. Session-state mapping

The adapter must map the Python runtime's internal session state to the
frontend's enum:

| Frontend state | Python condition |
|---|---|
| `INACTIVE` | No active takeover, no session |
| `ACTIVE` | `HumanControl` confirmed takeover |
| `PAUSED` | `HumanControl.pause()` was called |
| `STOPPED` | `HumanControl.stop()` was called |
| `RELEASED` | `HumanControl.release()` was called |

### 4. Command execution flow

```
Request → validate body
        → check session is ACTIVE (else 403)
        → PermissionManager.check(command)
        → ComputerControl.execute(command, session)
        → Verifier.verify(result)
        → Reporter.report(verified_result)
        → return RuntimeCommandResult
```

- `verified` must be `false` if `Verifier` cannot produce evidence.
- `status` must reflect the actual execution outcome, not a guess.
- `progress` entries should be collected during execution.

### 5. Security constraints

- Do not expose Ollama to the browser. LLM calls stay server-side.
- Do not log command text at INFO level.
- Reject requests with non-loopback `Origin` or `Host` headers.
- Enforce max 64 KB request body, max 2000 char command text.
- Return `503` if any internal component is unavailable — never fake a result.

### 6. Voice capability reporting

Until real engines are wired:

```python
{
  "wakeWord": {"status": "UNAVAILABLE", "confirmedByRuntime": False, ...},
  "recognition": {"status": "UNAVAILABLE", "confirmedByRuntime": False, ...},
  "speakerAuth": {"status": "UNAVAILABLE", "confirmedByRuntime": False, ...},
  "tts": {"status": "UNAVAILABLE", "confirmedByRuntime": False, ...}
}
```

When an engine is connected, report `READY` with `confirmedByRuntime: True`.
Only report `ACTIVE` when the engine is actively running (e.g. wake-word
detector is listening, TTS is speaking).

## How to test locally

1. Start the Python AGENT runtime server on `127.0.0.1:8787` on the Windows
   machine.
2. Run `npm run dev` in this Bolt project. Vite proxies `/api/runtime/*` to
   the Python server.
3. Open the frontend, click **Connect runtime**. The health and session
   endpoints must return successfully for the status to show CONNECTED.
4. Click **TAKE OVER** to request active control. The Python runtime must
   confirm the session transition.
5. Type a command and send it. The frontend will POST to `/commands` and
   display the verified result.
6. Test PAUSE, STOP, and RELEASE to confirm session transitions.
7. Open the Voice page — all four capabilities should show UNAVAILABLE until
   voice adapters are connected on the Python side.

## Files to copy into the Windows AGENT project

1. `docs/runtime-api-contract.md` — the API schema to implement.
2. This file — the adapter wiring guide.
3. `src/runtime/client.ts` and `src/runtime/voice-client.ts` — reference
   for the exact request/response shapes the frontend validates against.

# Architecture

Argox has one policy engine and several ways to connect an agent to it.

| Part | File | Role |
| --- | --- | --- |
| Policy engine | `agent/policy.py` | Tags content and decides allow, block or ask |
| Session tracking | `agent/instrumentation.py` | Holds session taint and records spans |
| Local hook server | `agent/hook_server.py` | Translates Claude Code hooks for local mode |
| Live relay | `agent/ws_relay.py` | Streams events to the local panel |
| Hosted backend | `agent/main.py` | Multi-tenant FastAPI service with API-key and Supabase auth |
| Dashboard | `frontend/src/` | Connect, Feed, Graph and Policy tabs |

## Data tainting

`policy.py` tags content as secret, PII or internal-only when it's read. The tags
stay in `TaintContext` for the session.

Before each call, `evaluate_call()` checks whether it would move tagged data
across the trust boundary. That covers external `call_api` and `WebFetch` calls,
and shell commands that reach the network. Writing to the local filesystem
doesn't count as crossing the boundary.

Argox also remembers scripts with network code that the session writes, so
running one later counts as network use.

## Decisions

- **Block:** the call doesn't run.
- **Ask:** the call pauses until a human approves or denies it.
- **Allow:** the call runs, and the event is still recorded.

Path, credential-store and destructive-command rules apply whatever the session's
taint state. Taint rules depend on what the session has read.

## Human confirmation

A `pending_confirm` decision sends a `confirm_request` event and waits. The Feed
tab shows Approve and Deny buttons, and the result is recorded as a
`confirm_resolution` event.

Locally, Argox falls back to a terminal prompt if the panel isn't reachable, and
to Claude Code's permission dialog if the relay is down.

Claude Code fails open on a non-2xx response or a hook timeout. So the hook server
always answers 200 with `hookSpecificOutput`, and the hook timeout must stay above
`CONFIRM_TIMEOUT_SECONDS` (110 seconds).

## Traces

Each session has one root span, so one SigNoz trace shows the session's full
story: tool call, classification, policy decision and human resolution. Later
spans parent to the root explicitly, because a Claude Code session is many separate
HTTP requests with no shared call stack.

## Policy editing

In local mode, `PolicyEditor.jsx` uses the hook server's `/policies` endpoints to
update `policies.json`, which is reloaded without a restart. Hosted projects store
their policies in Postgres.

## Claude Code notes

Claude Code reads hook settings when a session starts, so restart it after changing
them.

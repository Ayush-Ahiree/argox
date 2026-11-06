"""
Argox - Hosted, multi-tenant backend (FastAPI).

Consolidates what the local self-host path splits across two processes
(hook_server.py's HTTP hook routes + ws_relay.py's WebSocket relay) into
one deployable service, backed by Postgres (db.py) instead of
policies.json + an in-memory ring buffer. The local self-host path is
untouched -- this is an additional doorway in, not a replacement.

Two credential types for two callers (see auth.py):
  - Claude Code hooks (via the npm CLI's config) -> per-project API key.
  - The dashboard (logged-in user) -> Supabase JWT.

Run: `uvicorn main:app --host 0.0.0.0 --port 8080` (see fly.toml for the
hosted deployment; PORT/DATABASE_URL/SUPABASE_JWT_SECRET are read from env).
"""

import asyncio
import json
import os
import threading
import time
import uuid

from dotenv import load_dotenv

load_dotenv()  # local dev only -- Fly sets DATABASE_URL/SUPABASE_JWT_SECRET/etc via `flyctl secrets`, no .env there

import otel_setup  # noqa: F401  side effect: configures the OTel exporter.
# hook_server.main() does this same import before serving, but main.py
# never calls that function -- it only imports symbols from the module --
# so without this, the hosted backend ran on the SDK's no-op tracer:
# every event's trace_id was all-zeros and nothing reached SigNoz at all.

from fastapi import Depends, FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
import jwt as pyjwt

import auth
import db
from hook_server import (
    DECISION_TO_PERMISSION,
    TARGET_KEY_MAP,
    TOOL_NAME_MAP,
    _extract_target,
    _read_text_file,
    _stringify_output,
)
from feedback import clean_feedback
from instrumentation import precheck, record_confirm_resolution, record_tool_output, web_confirm
from policy import RULE_TOGGLE_LABELS, Decision

CONFIRM_TIMEOUT_SECONDS = 110.0
PORT = int(os.environ.get("PORT", "8080"))
# Comma-separated list of allowed frontend origins, e.g. production plus a
# stable Vercel branch-preview URL:
#   https://argox-six.vercel.app,https://argox-git-stage-xyz.vercel.app
# "*" (the default) allows any origin -- tighten it once deployed.
FRONTEND_ORIGIN = os.environ.get("FRONTEND_ORIGIN", "*")
ALLOWED_ORIGINS = [o.strip().rstrip("/") for o in FRONTEND_ORIGIN.split(",") if o.strip()] or ["*"]

app = FastAPI(title="Argox (hosted)")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if "*" in ALLOWED_ORIGINS else ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health():
    # Unauthenticated liveness probe -- pinged by .github/workflows/keep-alive.yml
    # so Render's free tier doesn't spin the service down after 15 min idle.
    return {"status": "ok"}


_LOOP = None
_connected: dict[str, set[WebSocket]] = {}

# Pending pause/confirm requests -- same shape as ws_relay.py's
# _PENDING_CONFIRMS, kept in-process here since main.py IS the relay for
# the hosted path (no separate process to bridge to over HTTP).
_pending_confirms: dict[str, bool] = {}
_pending_lock = threading.Lock()


@app.on_event("startup")
async def _startup():
    global _LOOP
    _LOOP = asyncio.get_event_loop()
    await db.init_pool()


@app.on_event("shutdown")
async def _shutdown():
    await db.close_pool()


# ------------------------------------------------------------------ auth ---

async def require_api_key_project(authorization: str = Header(None)) -> dict:
    """Resolves the project an agent-side call (Claude Code hook) belongs
    to, from `Authorization: Bearer <api-key>`."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing API key")
    key = authorization.removeprefix("Bearer ").strip()
    project = await db.get_project_by_api_key_hash(auth.hash_api_key(key))
    if not project:
        raise HTTPException(401, "invalid API key")
    return project


async def require_user(authorization: str = Header(None)) -> str:
    """Resolves the logged-in dashboard user from `Authorization: Bearer
    <supabase-jwt>`, returns their user_id."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing token")
    token = authorization.removeprefix("Bearer ").strip()
    try:
        return auth.verify_jwt(token)
    except pyjwt.PyJWTError:
        raise HTTPException(401, "invalid or expired token")


async def _owned_project_or_404(project_id: str, user_id: str) -> dict:
    project = await db.get_project_for_user(project_id, user_id)
    if not project:
        raise HTTPException(404, "project not found")
    return project


# ------------------------------------------------------------- publishing ---
# precheck()/record_tool_output()/etc. run off the event loop (see
# run_in_threadpool calls below) since they're sync functions with a
# blocking poll loop (web_confirm). Their publish_fn therefore has to hop
# back onto the loop thread to touch asyncio state (the DB pool, the
# WebSocket connections) -- same cross-thread handoff ws_relay.py's
# push_event() already does for the local relay, just without a second
# process in between here.

def _make_publisher(project_id: str):
    def publish(event: dict):
        asyncio.run_coroutine_threadsafe(_publish_async(project_id, event), _LOOP)
    return publish


async def _publish_async(project_id: str, event: dict):
    try:
        await db.insert_event(project_id, event)
    except Exception:
        pass  # a DB hiccup shouldn't break the hook decision path, which has already returned by the time this runs
    conns = _connected.get(project_id)
    if not conns:
        return
    msg = json.dumps(event)
    await asyncio.gather(*(ws.send_text(msg) for ws in list(conns)), return_exceptions=True)


# --------------------------------------------------------------- hooks ---
# Mirrors hook_server.py's _pre_tool_use/_post_tool_use (same TOOL_NAME_MAP,
# same decision contract Claude Code expects), project-scoped and async.

async def _decide(mapped_tool: str, target: str, params: dict, session_id: str, project_id: str, source: str, lineage: str = None) -> tuple[str, str]:
    """Shared by /hooks/pre-tool-use (Claude-shaped) and /v1/tool-call
    (generic) -- both just need an "allow"/"deny"/"ask" verdict + reason
    for the same (tool, target) off the same policy engine; they only
    differ in how the request/response gets translated at the edges.
    """
    policies = await db.get_policies(project_id)
    publish = _make_publisher(project_id)

    result = await run_in_threadpool(
        precheck,
        mapped_tool, target, params,
        session_id=session_id,
        project_id=project_id,
        deny_path_patterns=policies["deny_path_patterns"],
        rule_toggles=policies["rule_toggles"],
        publish_fn=publish,
        source=source,
        trusted_domains=policies["trusted_domains"],
        lineage=lineage,
    )

    if result.decision != Decision.PENDING_CONFIRM:
        return DECISION_TO_PERMISSION[result.decision], ("; ".join(result.reasons) if result.reasons else "ok")

    reason_text = "; ".join(result.reasons) if result.reasons else "confirmation needed"
    try:
        approved = await run_in_threadpool(
            web_confirm, mapped_tool, target, result.reasons,
            session_id=session_id, project_id=project_id, publish_fn=publish,
            timeout=CONFIRM_TIMEOUT_SECONDS,
            confirm_status_url=f"http://127.0.0.1:{PORT}/confirm-status",
        )
    except ConnectionError:
        return "ask", reason_text

    await run_in_threadpool(
        record_confirm_resolution, mapped_tool, target, bool(approved),
        session_id=session_id, project_id=project_id, publish_fn=publish,
    )
    if approved:
        return "allow", "approved via Argox dashboard"
    return "deny", f"denied via Argox dashboard (or timed out): {reason_text}"


@app.post("/hooks/pre-tool-use")
async def pre_tool_use(payload: dict, project: dict = Depends(require_api_key_project)):
    project_id = str(project["id"])
    tool_name = payload.get("tool_name", "")
    tool_input = payload.get("tool_input", {}) or {}
    session_id = payload.get("session_id")

    mapped_tool = TOOL_NAME_MAP.get(tool_name, tool_name.lower())
    target = _extract_target(tool_name, tool_input)

    permission, reason = await _decide(mapped_tool, target, tool_input, session_id, project_id, source="claude_code", lineage=payload.get("cwd"))

    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": permission,
            "permissionDecisionReason": reason,
        }
    }


@app.post("/hooks/post-tool-use")
async def post_tool_use(payload: dict, project: dict = Depends(require_api_key_project)):
    project_id = str(project["id"])
    tool_name = payload.get("tool_name", "")
    tool_input = payload.get("tool_input", {}) or {}
    # `tool_response` is what Claude Code actually sends (see hook_server.py)
    tool_output = payload.get("tool_response", payload.get("tool_output", ""))
    session_id = payload.get("session_id")

    mapped_tool = TOOL_NAME_MAP.get(tool_name, tool_name.lower())
    target = _extract_target(tool_name, tool_input)
    output_text = _stringify_output(tool_output)

    # Same as hook_server.py's post-hook: Read's tool_response carries no
    # content when the file is unchanged since the agent last read it, so
    # fall back to reading the file directly (this process has the same filesystem access the local
    # backend does -- true when self-hosted; for the hosted service this
    # only works if the agent's project happens to be on the same machine,
    # which won't generally be true once this runs on Fly.io. Left as-is
    # since it degrades gracefully (falls through to the empty string) --
    # revisit if PostToolUse content turns out to matter for the hosted
    # path's taint tagging in practice.
    if tool_name == "Read" and not output_text.strip():
        file_path = tool_input.get("file_path", "")
        if file_path:
            full_path = os.path.join(payload.get("cwd", ""), file_path)
            output_text = _read_text_file(full_path)

    publish = _make_publisher(project_id)
    policies = await db.get_policies(project_id)
    await run_in_threadpool(
        record_tool_output, mapped_tool, target, output_text,
        source_hint=target, session_id=session_id, project_id=project_id, publish_fn=publish,
        trusted_domains=policies["trusted_domains"], lineage=payload.get("cwd"),
    )

    return {"hookSpecificOutput": {"hookEventName": "PostToolUse"}}


# ----------------------------------------------------------- generic API ---
# Framework-neutral counterpart to /hooks/pre-tool-use and
# /hooks/post-tool-use above, for callers that aren't Claude Code and have
# no PreToolUse/PostToolUse hook mechanism to translate -- see
# sdk/python/argox for the client these are meant to be called from.
#
# Same policy engine, same taint tracking, same dashboard/events pipeline
# as the Claude hook routes (_decide/precheck/record_tool_output are all
# shared), just without the Claude-shaped request/response envelope.
# `action`/`target` are the engine's own generic vocabulary already used
# internally (see TOOL_NAME_MAP in hook_server.py and evaluate_call() in
# policy.py): "read_file" / "write_file" / "run_shell" / "call_api", though
# evaluate_call() falls through to a harmless ALLOW for any other string,
# so a caller with its own verb names still gets a decision, just no
# policy rules that specifically look for that verb.

@app.post("/v1/tool-call")
async def tool_call(payload: dict, project: dict = Depends(require_api_key_project)):
    project_id = str(project["id"])
    action = (payload.get("action") or "").strip()
    target = payload.get("target")
    if not action or target is None:
        raise HTTPException(422, "\"action\" and \"target\" are required")
    session_id = payload.get("session_id")
    params = payload.get("input") or {}

    # cwd (optional): lets a new session from the same agent working dir
    # inherit the previous session's sensitive-data tags
    decision, reason = await _decide(action, str(target), params, session_id, project_id, source="api", lineage=payload.get("cwd"))

    return {"decision": decision, "reason": reason}


@app.post("/v1/tool-result")
async def tool_result(payload: dict, project: dict = Depends(require_api_key_project)):
    project_id = str(project["id"])
    action = (payload.get("action") or "").strip()
    target = payload.get("target")
    if not action or target is None:
        raise HTTPException(422, "\"action\" and \"target\" are required")
    session_id = payload.get("session_id")
    output_text = _stringify_output(payload.get("output", ""))

    publish = _make_publisher(project_id)
    policies = await db.get_policies(project_id)
    await run_in_threadpool(
        record_tool_output, action, str(target), output_text,
        source_hint=str(target), session_id=session_id, project_id=project_id, publish_fn=publish,
        trusted_domains=policies["trusted_domains"], lineage=payload.get("cwd"),
    )
    return {"status": "ok"}


@app.get("/confirm-status")
async def confirm_status(id: str = Query(...)):
    with _pending_lock:
        if id in _pending_confirms:
            return {"resolved": True, "approved": _pending_confirms.pop(id)}
    return {"resolved": False}


@app.post("/confirm-response")
async def confirm_response(payload: dict, user_id: str = Depends(require_user)):
    # Not cross-checked against a specific project (confirm_id is an
    # unguessable uuid4, same trust model the local relay already used
    # with zero auth at all) -- this at least requires a logged-in user,
    # which the unauthenticated local relay never did.
    confirm_id = payload["id"]
    with _pending_lock:
        _pending_confirms[confirm_id] = bool(payload["approved"])
    return {"status": "ok"}


# ------------------------------------------------------------- projects ---

@app.get("/projects")
async def list_projects(user_id: str = Depends(require_user)):
    return await db.list_projects(user_id)


@app.post("/projects")
async def create_project(payload: dict, user_id: str = Depends(require_user)):
    name = (payload.get("name") or "").strip() or "default"
    key = auth.generate_api_key()
    project = await db.create_project(user_id, name, auth.hash_api_key(key), auth.key_prefix_for_display(key))
    # The plaintext key is only ever returned here, at creation time -- the
    # dashboard must show/copy it immediately, matching every other
    # DSN/API-key-issuing SaaS (Stripe, Sentry, ...). Only the hash is
    # stored, so it can't be recovered later, only rotated.
    return {**project, "api_key": key}


@app.post("/projects/{project_id}/rotate-key")
async def rotate_key(project_id: str, user_id: str = Depends(require_user)):
    await _owned_project_or_404(project_id, user_id)
    key = auth.generate_api_key()
    project = await db.rotate_project_key(project_id, user_id, auth.hash_api_key(key), auth.key_prefix_for_display(key))
    return {**project, "api_key": key}


@app.get("/projects/{project_id}/policies")
async def get_project_policies(project_id: str, user_id: str = Depends(require_user)):
    await _owned_project_or_404(project_id, user_id)
    policies = await db.get_policies(project_id)
    return {**policies, "rule_toggle_labels": RULE_TOGGLE_LABELS}


@app.post("/projects/{project_id}/policies")
async def update_project_policies(project_id: str, payload: dict, user_id: str = Depends(require_user)):
    await _owned_project_or_404(project_id, user_id)
    result = {}
    if "deny_path_patterns" in payload:
        result["deny_path_patterns"] = await db.set_deny_path_patterns(project_id, payload["deny_path_patterns"])
    if "rule_toggles" in payload:
        result["rule_toggles"] = await db.set_rule_toggles(project_id, payload["rule_toggles"])
    if "trusted_domains" in payload:
        if not isinstance(payload["trusted_domains"], list):
            raise HTTPException(422, "trusted_domains must be a list")
        try:
            result["trusted_domains"] = await db.set_trusted_domains(project_id, payload["trusted_domains"])
        except db.MigrationMissing as e:
            raise HTTPException(503, str(e))
    policies = await db.get_policies(project_id)
    return {**policies, **result}


@app.post("/projects/{project_id}/feedback")
async def project_feedback(project_id: str, payload: dict, user_id: str = Depends(require_user)):
    """'Was this decision right?' from the Graph's step panel."""
    await _owned_project_or_404(project_id, user_id)
    record = clean_feedback(payload)
    if record is None:
        raise HTTPException(422, "verdict must be 'correct' or 'false_positive'")
    try:
        await db.insert_feedback(project_id, user_id, record)
    except db.MigrationMissing as e:
        raise HTTPException(503, str(e))
    return {"ok": True}


# ------------------------------------------------------------- websocket ---

@app.websocket("/ws")
async def ws_stream(websocket: WebSocket, project_id: str = Query(...), token: str = Query(...)):
    try:
        user_id = auth.verify_jwt(token)
    except pyjwt.PyJWTError:
        await websocket.close(code=4401)
        return
    project = await db.get_project_for_user(project_id, user_id)
    if not project:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    _connected.setdefault(project_id, set()).add(websocket)
    try:
        for event in await db.recent_events(project_id):
            await websocket.send_text(json.dumps(event))
        while True:
            await websocket.receive_text()  # dashboard doesn't send anything; just keeps the connection alive / detects disconnect
    except WebSocketDisconnect:
        pass
    finally:
        _connected.get(project_id, set()).discard(websocket)

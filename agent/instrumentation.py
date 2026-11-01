"""
Argox - Instrumentation Middleware

Wraps every tool call in an OTel span, tags/propagates taint via span
attributes (baggage-style manual propagation kept simple for hackathon
reliability), runs the policy engine, and mirrors each event to the
Argox live panel via a WebSocket broadcaster.

Design choice: rather than reading spans back OUT of SigNoz for the live
panel (adds a dependency on SigNoz query latency during the demo), we
mirror events to the frontend at EMIT time. SigNoz remains the system of
record for dashboards/alerts; the panel is a live tap on the same stream.
"""

import threading
import time
import uuid
import json
from contextlib import contextmanager

from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode, NonRecordingSpan, set_span_in_context, SpanKind

from policy import classify_content, evaluate_call, script_network_reach, Decision, PolicyResult, Tag

tracer = trace.get_tracer("argox")

# Session-level taint state: which tags are "in scope" for the current
# agent run, accumulated as tools produce tagged output. Simple dict
# instead of a general dataflow graph -> fast to build, good enough to demo.
class TaintContext:
    def __init__(self, session_id: str = None):
        self.session_id = session_id or str(uuid.uuid4())
        self.active_tags = set()  # tags currently "carried" by the agent's working memory
        self.history = []
        self.root_span_context = None  # lazily created -- see _session_parent_context
        # {basename: reaches_external} for files this session wrote that
        # contain network code, so running one later counts as network use
        self.network_scripts = {}

    def absorb(self, tags: set):
        self.active_tags |= tags

    def snapshot(self):
        return sorted(t.value if hasattr(t, "value") else t for t in self.active_tags)


def _session_parent_context(ctx: "TaintContext"):
    """Every span for a session -- tool-call decisions AND taint-tagging
    events -- shares one trace_id, so opening ANY ONE span in SigNoz's
    Trace Explorer shows the WHOLE session as a real parent/child
    waterfall instead of an unordered flat list of independent
    one-span traces (which is what this looked like before: every tool
    call got its own random trace_id, so "see everything for this
    session" meant manually filtering+sorting a list, and taint events
    had no span at all).

    A Claude Code session spans many independent HTTP requests to
    hook_server.py (a new thread per request, no shared call stack), so
    this can't rely on OTel's ambient current-span context the way
    normal nested calls do -- each span's parent is set explicitly from
    a stored SpanContext instead. The root span is created once per
    session and ended immediately: it's a trace-ID anchor, not a
    meaningful duration (a session doesn't have a clean "done" moment we
    could hook to end it later, and the SDK's BatchSpanProcessor only
    exports a span once it ends)."""
    if ctx.root_span_context is None:
        # Fixed name, not f"session:{ctx.session_id}" -- embedding the
        # unique session id in the SPAN NAME (rather than just the
        # session.id ATTRIBUTE, which was already set) makes every
        # session its own distinct "operation name" from SigNoz's
        # perspective. That's unbounded cardinality: found by actually
        # re-checking the Services page after the fix and seeing
        # "overflow_operation" persist -- each new session was creating
        # a brand new top-level op name forever, hitting whatever cap
        # SigNoz has on distinct root operations, same failure mode as
        # before the fix, just reintroduced a different way.
        root_span = tracer.start_span("session", kind=SpanKind.SERVER)
        root_span.set_attribute("session.id", ctx.session_id)
        ctx.root_span_context = root_span.get_span_context()
        root_span.end()
    return set_span_in_context(NonRecordingSpan(ctx.root_span_context))


def _trace_id_hex(ctx: "TaintContext") -> str:
    """32-char hex trace ID for this session's shared trace, in the form
    SigNoz's own trace-detail URL expects. Call after
    _session_parent_context(ctx) has run at least once (root_span_context
    is lazily created there) -- every broadcast site below already opens
    a span via that call first, so this is always populated by the time
    an event goes out. Lets the panel deep-link an event straight to its
    real SigNoz trace instead of just asserting "it's all one trace"."""
    if ctx.root_span_context is None:
        return None
    return format(ctx.root_span_context.trace_id, "032x")


# The toy agent is one short-lived process per run, so a single module-level
# context is correct for it. hook_server.py is a long-running process that
# serves MANY distinct Claude Code sessions over its lifetime, so it can't
# share this one singleton -- doing so would merge unrelated sessions into
# the same incident card and leak taint tags between them (session A reads
# a secret, unrelated session B inherits the tag and gets blocked for no
# reason). _session_contexts keys a separate TaintContext per Claude Code
# session_id; get_taint_context(None) returns the toy agent's singleton.
taint_ctx = TaintContext()
_session_contexts = {}
_session_contexts_lock = threading.Lock()


def get_taint_context(session_id: str = None, project_id: str = None) -> TaintContext:
    """project_id: the hosted backend (agent/main.py) serves many tenants
    from one process, same reason hook_server.py already needed per-session
    isolation below -- without this, two different customers' sessions
    could share a TaintContext just because they happened to reuse a
    session_id. Local self-host callers never pass project_id, so the key
    collapses to plain session_id, unchanged from before this was
    multi-tenant."""
    if not session_id:
        return taint_ctx
    key = (project_id, session_id)
    with _session_contexts_lock:
        if key not in _session_contexts:
            _session_contexts[key] = TaintContext(session_id=session_id)
        return _session_contexts[key]


RELAY_INGEST_URL = "http://localhost:8766/event"


def broadcast(event: dict):
    """Send an event to the Argox panel via the relay's HTTP ingest
    endpoint. The relay runs as a SEPARATE process, so this must go over
    the network (HTTP), not a direct Python import/function call — module
    state isn't shared across processes."""
    try:
        import urllib.request
        data = json.dumps(event).encode()
        req = urllib.request.Request(
            RELAY_INGEST_URL, data=data, headers={"Content-Type": "application/json"}, method="POST"
        )
        urllib.request.urlopen(req, timeout=1)
    except Exception:
        pass  # relay not running; instrumentation still works standalone


@contextmanager
def traced_tool_call(tool_name: str, target: str, params: dict):
    """Use as: with traced_tool_call("call_api", url, {...}) as ctx: ... 
    ctx.decision tells the caller whether to actually execute the tool."""

    start = time.time()
    policy_result = evaluate_call(tool_name, target, params, taint_ctx.active_tags)

    with tracer.start_as_current_span(f"tool.{tool_name}", context=_session_parent_context(taint_ctx)) as span:
        span.set_attribute("tool.name", tool_name)
        span.set_attribute("tool.target", target)
        span.set_attribute("tool.params_json", json.dumps(params)[:500])
        span.set_attribute("data.tags", ",".join(taint_ctx.snapshot()))
        span.set_attribute("risk.score", policy_result.risk_score)
        span.set_attribute("policy.decision", policy_result.decision.value)
        span.set_attribute("policy.reasons", ",".join(policy_result.reasons))
        span.set_attribute("session.id", taint_ctx.session_id)
        span.set_attribute("source", "toy_agent")

        event = {
            "type": "tool_call",
            "session_id": taint_ctx.session_id,
            "tool": tool_name,
            "target": target,
            "tags": taint_ctx.snapshot(),
            "risk_score": policy_result.risk_score,
            "decision": policy_result.decision.value,
            "reasons": policy_result.reasons,
            "trace_id": _trace_id_hex(taint_ctx),
            "ts": start,
        }
        broadcast(event)

        if policy_result.decision == Decision.BLOCK:
            span.set_status(Status(StatusCode.ERROR, "blocked_by_policy"))
            span.add_event("policy.flag_raised", {"reasons": ",".join(policy_result.reasons)})

        class Ctx:
            decision = policy_result.decision
            reasons = policy_result.reasons

        yield Ctx()

        span.set_attribute("duration_ms", int((time.time() - start) * 1000))


def precheck(
    tool_name: str,
    target: str,
    params: dict,
    override_reason: str = None,
    session_id: str = None,
    project_id: str = None,
    deny_path_patterns: list = None,
    rule_toggles: dict = None,
    publish_fn=None,
    source: str = "claude_code",
) -> PolicyResult:
    """Decision + telemetry only, no execution — for callers that don't run
    the tool themselves (the Claude Code PreToolUse hook adapter: Claude
    Code executes the tool after we hand back allow/deny/ask, we never
    touch the filesystem/shell/network here).

    override_reason: short-circuits straight to BLOCK (used for the hard
    path denylist in policy.check_path_denylist, which applies regardless
    of taint state and shouldn't wait on evaluate_call's taint-based rules).

    session_id: Claude Code's own session id. hook_server.py is one
    long-running process serving many distinct Claude Code sessions, so
    each needs its own isolated TaintContext (see get_taint_context) --
    without this, an unrelated session could inherit another session's
    taint tags, or two sessions would render as one merged incident card.

    project_id / deny_path_patterns / rule_toggles / publish_fn: hosted
    multi-tenant backend only (agent/main.py). project_id isolates the
    TaintContext per tenant; deny_path_patterns/rule_toggles are the
    project's own Postgres-backed policy (fetched async by the caller,
    since this function itself stays sync); publish_fn lets the hosted
    backend insert into Postgres + fan out over its own WebSocket instead
    of the local broadcast() (POST to the local relay process), which the
    hosted service doesn't run. All default to the pre-multi-tenant local
    behavior when omitted.

    source: how this call reached the engine -- "claude_code" (default,
    the PreToolUse hook) or "api" (the generic /v1/tool-call route in
    main.py, used by non-Claude agents via the SDK). Recorded on the span
    and in the published event so the dashboard (sessionUtils.js,
    pathLayout.js) can label sessions correctly instead of every
    non-Claude caller falling into the "claude_code"/"toy_agent" binary.
    """
    ctx = get_taint_context(session_id, project_id=project_id)
    publish = publish_fn or broadcast

    if override_reason:
        policy_result = PolicyResult(Decision.BLOCK, 100, [override_reason])
    else:
        policy_result = evaluate_call(
            tool_name, target, params, ctx.active_tags,
            deny_path_patterns=deny_path_patterns, rule_toggles=rule_toggles,
            network_scripts=ctx.network_scripts,
        )

    # Remember scripts with network code as the agent writes them (Write's
    # `content`, Edit's `new_string`, NotebookEdit's `new_source`): the
    # hosted backend can't read the user's disk, but every write passes
    # through here with its content.
    if tool_name == "write_file" and policy_result.decision != Decision.BLOCK and isinstance(params, dict):
        written = "\n".join(str(params.get(k) or "") for k in ("content", "new_string", "new_source"))
        reach = script_network_reach(written)
        if reach is not None:
            name = str(target).replace("\\", "/").rsplit("/", 1)[-1]
            ctx.network_scripts[name] = ctx.network_scripts.get(name, False) or reach

    with tracer.start_as_current_span(f"tool.{tool_name}", context=_session_parent_context(ctx)) as span:
        span.set_attribute("tool.name", tool_name)
        span.set_attribute("tool.target", target)
        span.set_attribute("tool.params_json", json.dumps(params)[:500])
        span.set_attribute("data.tags", ",".join(ctx.snapshot()))
        span.set_attribute("risk.score", policy_result.risk_score)
        span.set_attribute("policy.decision", policy_result.decision.value)
        span.set_attribute("policy.reasons", ",".join(policy_result.reasons))
        span.set_attribute("session.id", ctx.session_id)
        span.set_attribute("source", source)

        if policy_result.decision == Decision.BLOCK:
            span.set_status(Status(StatusCode.ERROR, "blocked_by_policy"))
            span.add_event("policy.flag_raised", {"reasons": ",".join(policy_result.reasons)})

        publish({
            "type": "tool_call",
            "session_id": ctx.session_id,
            "tool": tool_name,
            "target": target,
            "tags": ctx.snapshot(),
            "risk_score": policy_result.risk_score,
            "decision": policy_result.decision.value,
            "reasons": policy_result.reasons,
            "trace_id": _trace_id_hex(ctx),
            "ts": time.time(),
            "source": source,
        })

    return policy_result


def record_confirm_resolution(tool_name: str, target: str, approved: bool, session_id: str = None, project_id: str = None, publish_fn=None):
    """A pending_confirm decision doesn't end at evaluate_call() anymore --
    a human resolves it. Broadcast the actual outcome so the panel/
    telemetry stream reflects what really happened, not just the
    pre-human-input pause. Also a real span, linked into the session's
    trace like everything else.

    project_id / publish_fn: see precheck()."""
    ctx = get_taint_context(session_id, project_id=project_id)
    publish = publish_fn or broadcast

    with tracer.start_as_current_span("confirm.resolution", context=_session_parent_context(ctx)) as span:
        span.set_attribute("tool.name", tool_name)
        span.set_attribute("tool.target", target)
        span.set_attribute("approved", approved)
        span.set_attribute("session.id", ctx.session_id)

    publish({
        "type": "confirm_resolution",
        "session_id": ctx.session_id,
        "tool": tool_name,
        "target": target,
        "decision": "allow" if approved else "block",
        "trace_id": _trace_id_hex(ctx),
        "ts": time.time(),
    })


def web_confirm(tool_name: str, target: str, reasons: list, session_id: str = None, timeout: float = 110.0, project_id: str = None, publish_fn=None, confirm_status_url: str = None):
    """Broadcast a confirm_request (the panel shows Approve/Deny buttons)
    and poll for a decision. Shared by tools.py's toy-agent confirm flow
    and hook_server.py's Claude Code PENDING_CONFIRM path -- same
    mechanism, same panel, either front-end.

    Returns True/False if a human resolved it via the panel, or None if
    the timeout elapsed with the relay still reachable (caller should
    default-deny -- fail safe, not fail open). Raises ConnectionError if
    the relay itself was never reachable at all, so each caller can use
    its own non-panel fallback (tools.py's CLI prompt, Claude Code's own
    native "ask" dialog).

    project_id / publish_fn: see precheck(). confirm_status_url: where to
    poll for the resolution -- defaults to the local relay's HTTP endpoint;
    the hosted backend (agent/main.py) passes its own in-process resolver
    instead of polling itself over HTTP.
    """
    import urllib.error
    import urllib.request
    import uuid

    ctx = get_taint_context(session_id, project_id=project_id)
    publish = publish_fn or broadcast
    _session_parent_context(ctx)  # ensure root_span_context exists so trace_id below is real, not None
    confirm_id = str(uuid.uuid4())
    publish({
        "type": "confirm_request",
        "id": confirm_id,
        "session_id": ctx.session_id,
        "tool": tool_name,
        "target": target,
        "reasons": reasons,
        "trace_id": _trace_id_hex(ctx),
        "ts": time.time(),
    })

    status_url = confirm_status_url or f"http://localhost:8766/confirm-status?id={confirm_id}"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(status_url, timeout=3) as resp:
                data = json.loads(resp.read())
        except (urllib.error.URLError, OSError) as e:
            raise ConnectionError("relay unreachable") from e
        if data.get("resolved"):
            return bool(data.get("approved"))
        time.sleep(1)
    return None  # genuine timeout -- relay was reachable, nobody answered


def record_tool_output(tool_name: str, target: str, output_text: str, source_hint: str = "", session_id: str = None, project_id: str = None, publish_fn=None):
    """Call after a tool executes successfully: classify the OUTPUT and
    absorb any new taint tags into the session context so downstream
    tool calls inherit them (this is the propagation step).

    session_id: see precheck() -- this is the function that actually
    absorbs taint, so it's the one that most needs per-session isolation
    (otherwise one Claude Code session's secret read taints every other
    session hitting the same hook_server.py process).

    This used to be invisible to SigNoz entirely -- classify_content()
    ran, taint got absorbed, but no span was ever created, so "data
    entered the agent and got tagged PII" (literally the PRD's G2) never
    showed up anywhere but our own WebSocket stream. Now it's a real
    span, linked into the same per-session trace as the tool-call spans.

    project_id / publish_fn: see precheck()."""
    ctx = get_taint_context(session_id, project_id=project_id)
    publish = publish_fn or broadcast
    result = classify_content(output_text, source_hint=source_hint)

    with tracer.start_as_current_span("taint.classify", context=_session_parent_context(ctx)) as span:
        span.set_attribute("tool.name", tool_name)
        span.set_attribute("tool.target", target)
        span.set_attribute("new_tags", ",".join(t.value for t in result.tags if t != Tag.PUBLIC))
        span.set_attribute("session.id", ctx.session_id)

    ctx.absorb(result.tags)

    publish({
        "type": "taint_update",
        "session_id": ctx.session_id,
        "tool": tool_name,
        "target": target,
        "new_tags": [t.value for t in result.tags if t != Tag.PUBLIC],
        "trace_id": _trace_id_hex(ctx),
        "ts": time.time(),
    })
    return result

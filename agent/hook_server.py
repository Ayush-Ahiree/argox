"""
Argox - Claude Code HTTP Hook Server (Feature F)

The only new component for the Claude Code integration: a thin adapter
that translates Claude Code's PreToolUse/PostToolUse hook JSON into calls
against the SAME policy engine and taint context the toy agent uses
(policy.py's evaluate_call()/classify_content(), instrumentation.py's
taint_ctx). Nothing about the policy/observability engine changes to
support this — Claude Code is just a second caller.

Routes:
  POST /hooks/pre-tool-use   -> allow / deny / ask
  POST /hooks/post-tool-use  -> classify output, absorb taint
  GET  /policies             -> current path-denylist patterns + rule toggles
  POST /policies             -> replace patterns and/or rule toggles (Policy tab in the UI)

Claude Code HTTP hook contract (see code.claude.com/docs/hooks):
  - Request body has tool_name / tool_input (PreToolUse) or
    tool_name / tool_input / tool_output (PostToolUse).
  - Response must be 2xx with a JSON body to actually take effect:
    {"hookSpecificOutput": {"hookEventName": ..., "permissionDecision":
     "allow"|"deny"|"ask", "permissionDecisionReason": "..."}}
  - Non-2xx or a timeout FAILS OPEN (Claude Code proceeds as if allowed),
    so this server must always answer 200 with a decision.
"""

import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from feedback import clean_feedback
from instrumentation import precheck, record_tool_output, record_confirm_resolution, web_confirm
from policy import (
    Decision,
    RULE_TOGGLE_LABELS,
    get_deny_path_patterns,
    get_rule_toggles,
    get_trusted_domains,
    set_deny_path_patterns,
    set_rule_toggles,
    set_trusted_domains,
)

FEEDBACK_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "feedback.jsonl")

# How long to wait for a human to click Approve/Deny in the panel before
# defaulting to deny. Must be well under Claude Code's own hook timeout
# (see .claude/settings.json) -- if the hook times out first, Claude Code
# FAILS OPEN (treats it as allowed) regardless of what we'd have decided.
CONFIRM_TIMEOUT_SECONDS = 110.0

# Claude Code tool name -> our internal tool vocabulary (matches the
# vocab evaluate_call() already understands from the toy agent).
TOOL_NAME_MAP = {
    "Read": "read_file",
    "Edit": "write_file",
    "Write": "write_file",
    "NotebookEdit": "write_file",
    "Bash": "run_shell",
    "WebFetch": "call_api",
    # Grep reads file contents, so it gets the same path denylist as Read
    # (see _extract_target for how its target is built)
    "Grep": "read_file",
}

# Tools whose target lives under a path-shaped key vs. a command/url key.
TARGET_KEY_MAP = {
    "Read": "file_path",
    "Edit": "file_path",
    "Write": "file_path",
    "NotebookEdit": "notebook_path",
    "Bash": "command",
    "WebFetch": "url",
    "WebSearch": "query",
}

DECISION_TO_PERMISSION = {
    Decision.ALLOW: "allow",
    Decision.BLOCK: "deny",
    Decision.PENDING_CONFIRM: "ask",
}


def _extract_target(tool_name: str, tool_input: dict) -> str:
    if tool_name == "Grep":
        # path (file or dir) plus the glob filter if any, so both
        # `Grep path=<denylisted file>` and `Grep glob=<denylisted name>`
        # hit the path denylist
        base = str(tool_input.get("path") or ".")
        glob = tool_input.get("glob")
        return os.path.join(base, str(glob)) if glob else base
    if tool_name.startswith("mcp__"):
        # the policy engine checks the full arguments (params); the target
        # is what the dashboard shows
        return f"{tool_name} {json.dumps(tool_input, default=str)[:200]}"
    key = TARGET_KEY_MAP.get(tool_name)
    if key and key in tool_input:
        return str(tool_input[key])
    return json.dumps(tool_input)[:200]


def _read_text_file(path: str) -> str:
    """Contents of `path` for classification, or "" for a binary file.
    Decoding an image/archive as text with errors="ignore" produces junk
    whose random digit runs match PHONE_RE -- found 2026-10-11: every PNG
    screenshot the agent read got tagged PII and tainted the session. A NUL
    byte in the first 8KB is the usual binary heuristic (same as git's)."""
    try:
        with open(path, "rb") as f:
            head = f.read(8192)
            if b"\0" in head:
                return ""
            return (head + f.read()).decode("utf-8", errors="ignore")
    except OSError:
        return ""


MAX_OUTPUT_CHARS = 200_000


def _stringify_output(tool_output) -> str:
    """Every string in a tool's response, joined. Claude Code's
    tool_response shape differs per tool (Read: {"file": {"content"}},
    Bash: {"stdout", "stderr"}, MCP tools: arbitrary), and the old
    "pick the likeliest key" version missed most of them -- so collect
    all string leaves instead of guessing which one holds the data."""
    parts = []
    size = 0

    def walk(value):
        nonlocal size
        if size >= MAX_OUTPUT_CHARS:
            return
        if isinstance(value, str):
            parts.append(value)
            size += len(value)
        elif isinstance(value, dict):
            for v in value.values():
                walk(v)
        elif isinstance(value, (list, tuple)):
            for v in value:
                walk(v)

    walk(tool_output)
    return "\n".join(parts)[:MAX_OUTPUT_CHARS]


class HookHandler(BaseHTTPRequestHandler):
    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(body or b"{}")
        except json.JSONDecodeError:
            return {}

    def _respond_json(self, obj: dict, status: int = 200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path == "/policies":
            self._respond_json(
                {
                    "deny_path_patterns": get_deny_path_patterns(),
                    "rule_toggles": get_rule_toggles(),
                    "trusted_domains": get_trusted_domains(),
                    "rule_toggle_labels": RULE_TOGGLE_LABELS,
                }
            )
        elif self.path == "/connect.sh":
            self._connect_script()
        else:
            self._respond_json({"error": "not found"}, 404)

    def _connect_script(self):
        # One-command onboarding: `curl .../connect.sh | bash -s -- <dir>`.
        # Delegates straight to `cli.py connect` (same process's own CLI,
        # same absolute path this server was launched from) instead of
        # re-implementing the settings.json merge here -- one source of
        # truth for that logic, this just makes it reachable without the
        # customer needing to know where cli.py lives on disk.
        cli_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cli.py")
        script = (
            "#!/usr/bin/env bash\n"
            "set -euo pipefail\n"
            f'exec python3 {json.dumps(cli_path)} connect "${{1:-$(pwd)}}"\n'
        )
        data = script.encode()
        self.send_response(200)
        self._cors_headers()
        self.send_header("Content-Type", "text/x-sh")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path == "/hooks/pre-tool-use":
            self._pre_tool_use()
        elif self.path == "/hooks/post-tool-use":
            self._post_tool_use()
        elif self.path == "/policies":
            self._update_policies()
        elif self.path == "/feedback":
            self._feedback()
        else:
            self._respond_json({"error": "not found"}, 404)

    def _feedback(self):
        record = clean_feedback(self._read_json())
        if record is None:
            self._respond_json({"error": "expected verdict: correct | false_positive"}, 400)
            return
        record["created_at"] = time.time()
        with open(FEEDBACK_FILE, "a") as f:
            f.write(json.dumps(record) + "\n")
        self._respond_json({"ok": True})

    def _update_policies(self):
        payload = self._read_json()
        has_patterns = "deny_path_patterns" in payload
        has_toggles = "rule_toggles" in payload
        has_trusted = "trusted_domains" in payload
        if not has_patterns and not has_toggles and not has_trusted:
            self._respond_json({"error": "expected deny_path_patterns, rule_toggles and/or trusted_domains"}, 400)
            return

        result = {}
        if has_patterns:
            patterns = payload.get("deny_path_patterns")
            if not isinstance(patterns, list):
                self._respond_json({"error": "deny_path_patterns must be a list"}, 400)
                return
            result["deny_path_patterns"] = set_deny_path_patterns(patterns)
        if has_toggles:
            toggles = payload.get("rule_toggles")
            if not isinstance(toggles, dict):
                self._respond_json({"error": "rule_toggles must be an object"}, 400)
                return
            result["rule_toggles"] = set_rule_toggles(toggles)
        if has_trusted:
            domains = payload.get("trusted_domains")
            if not isinstance(domains, list):
                self._respond_json({"error": "trusted_domains must be a list"}, 400)
                return
            result["trusted_domains"] = set_trusted_domains(domains)

        if not has_patterns:
            result["deny_path_patterns"] = get_deny_path_patterns()
        if not has_toggles:
            result["rule_toggles"] = get_rule_toggles()
        if not has_trusted:
            result["trusted_domains"] = get_trusted_domains()
        self._respond_json(result)

    def _pre_tool_use(self):
        payload = self._read_json()
        tool_name = payload.get("tool_name", "")
        tool_input = payload.get("tool_input", {}) or {}
        session_id = payload.get("session_id")

        mapped_tool = TOOL_NAME_MAP.get(tool_name, tool_name.lower())
        target = _extract_target(tool_name, tool_input)

        # path denylist (admin/**, .env*, secrets/**) is now enforced
        # inside evaluate_call() itself, so both front-ends get it uniformly.
        # session_id keeps each Claude Code session's taint state isolated --
        # this process serves many sessions over its lifetime, not just one.
        # cwd: the session's folder, so a new session started there inherits
        # the previous one's sensitive-data tags (see get_taint_context)
        result = precheck(mapped_tool, target, tool_input, session_id=session_id, lineage=payload.get("cwd"))

        if result.decision == Decision.PENDING_CONFIRM:
            # Same panel, same Approve/Deny buttons the toy agent uses --
            # not Claude Code's own native "ask" dialog. Only falls back
            # to "ask" if the relay itself is unreachable.
            reason_text = "; ".join(result.reasons) if result.reasons else "confirmation needed"
            try:
                approved = web_confirm(mapped_tool, target, result.reasons, session_id=session_id, timeout=CONFIRM_TIMEOUT_SECONDS)
            except ConnectionError:
                permission, reason = "ask", reason_text
            else:
                record_confirm_resolution(mapped_tool, target, bool(approved), session_id=session_id)
                if approved:
                    permission, reason = "allow", "approved via Argox panel"
                else:
                    permission, reason = "deny", f"denied via Argox panel (or timed out): {reason_text}"
        else:
            permission = DECISION_TO_PERMISSION[result.decision]
            reason = "; ".join(result.reasons) if result.reasons else "ok"

        self._respond_json({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": permission,
                "permissionDecisionReason": reason,
            }
        })

    def _post_tool_use(self):
        payload = self._read_json()
        tool_name = payload.get("tool_name", "")
        tool_input = payload.get("tool_input", {}) or {}
        # Claude Code sends the result as `tool_response` (verified against a
        # captured live payload, 2026-10-11) -- this used to read
        # `tool_output`, which Claude Code never sends, so every tool's
        # output was classified as empty and only Read worked, via the
        # disk fallback below.
        tool_output = payload.get("tool_response", payload.get("tool_output", ""))
        session_id = payload.get("session_id")

        mapped_tool = TOOL_NAME_MAP.get(tool_name, tool_name.lower())
        target = _extract_target(tool_name, tool_input)
        output_text = _stringify_output(tool_output)

        # Verified live (2026-07-26): Claude Code's real PostToolUse event
        # for Read comes back with tool_output == "" even on a genuinely
        # successful read -- the earlier "verified via curl" note in
        # PROJECT_STATUS.md only ever exercised a hand-crafted payload with
        # fake content, never a real Read hook event, so this was never
        # actually working end-to-end. Since hook_server.py runs on the same
        # machine with the same filesystem access, just read the file
        # directly instead of trusting the hook payload for content.
        #
        # file_path can be relative to the CALLING session's cwd (Claude
        # Code's own working directory, sent as payload["cwd"]) -- NOT
        # relative to this process's own cwd (hook_server.py runs from
        # agent/, so a naive open(file_path) silently resolved to the
        # wrong location and the except OSError swallowed it, found by
        # actually re-testing with a relative path instead of assuming the
        # first absolute-path test generalized). os.path.join discards the
        # cwd prefix automatically if file_path is already absolute.
        if tool_name == "Read" and not output_text.strip():
            file_path = tool_input.get("file_path", "")
            if file_path:
                full_path = os.path.join(payload.get("cwd", ""), file_path)
                output_text = _read_text_file(full_path)

        record_tool_output(mapped_tool, target, output_text, source_hint=target, session_id=session_id, lineage=payload.get("cwd"))

        # Always allow post-hoc (data is already read); we only pause/deny
        # in PreToolUse. Empty hookSpecificOutput = no override.
        self._respond_json({"hookSpecificOutput": {"hookEventName": "PostToolUse"}})

    def log_message(self, format, *args):
        pass  # quiet; the console is busy enough during a demo


def main():
    import os
    import otel_setup  # noqa: F401  side effect: configures the OTel exporter

    host = os.environ.get("HOOK_SERVER_HOST", "localhost")
    port = int(os.environ.get("HOOK_SERVER_PORT", "8090"))
    server = ThreadingHTTPServer((host, port), HookHandler)
    print(f"Argox hook server listening on http://{host}:{port}/hooks/{{pre,post}}-tool-use")
    server.serve_forever()


if __name__ == "__main__":
    main()

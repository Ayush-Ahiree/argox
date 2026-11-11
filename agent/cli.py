"""
Argox CLI — turns the multi-terminal, hand-edited-JSON setup in
README.md into a few commands:

    python cli.py start                  # bring up relay + hook server
    python cli.py connect [project_dir]  # wire hooks into a project's
                                          # .claude/settings.json
    python cli.py status                 # is everything up?
    python cli.py stop                   # tear down what `start` started

Runs standalone (stdlib only) so `connect`/`status`/`stop` work even
without the OTel/websockets deps installed — only `start` needs those,
since it's the one that actually imports and runs the relay/hook server.
"""

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import time

AGENT_DIR = os.path.dirname(os.path.abspath(__file__))
RUN_DIR = os.path.join(AGENT_DIR, ".run")

HOOK_SERVER_HOST = os.environ.get("HOOK_SERVER_HOST", "localhost")
HOOK_SERVER_PORT = int(os.environ.get("HOOK_SERVER_PORT", "8090"))
HOOK_BASE_URL = f"http://{HOOK_SERVER_HOST}:{HOOK_SERVER_PORT}"

RELAY_WS_PORT = 8765
RELAY_HTTP_PORT = 8766

SERVICES = {
    "relay": {
        "script": "ws_relay.py",
        "ports": [RELAY_WS_PORT, RELAY_HTTP_PORT],
        "label": "WebSocket relay (panel feed)",
    },
    "hook": {
        "script": "hook_server.py",
        "ports": [HOOK_SERVER_PORT],
        "label": "Claude Code hook server",
    },
}

HOOK_CONFIG = {
    "PreToolUse": {
        "matcher": "Read|Edit|Write|NotebookEdit|Bash|WebFetch|Grep|mcp__.*",
        "url": f"{HOOK_BASE_URL}/hooks/pre-tool-use",
        "timeout": 120,
    },
    "PostToolUse": {
        "matcher": "Read|WebFetch|WebSearch|Bash|Grep|mcp__.*",
        "url": f"{HOOK_BASE_URL}/hooks/post-tool-use",
        "timeout": 10,
    },
}


def _port_open(port, host="localhost", timeout=0.3):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        return sock.connect_ex((host, port)) == 0


def _pid_file(name):
    return os.path.join(RUN_DIR, f"{name}.pid")


def _log_file(name):
    return os.path.join(RUN_DIR, f"{name}.log")


def _running_pid(name):
    path = _pid_file(name)
    if not os.path.exists(path):
        return None
    try:
        pid = int(open(path).read().strip())
    except (ValueError, OSError):
        return None
    try:
        os.kill(pid, 0)  # signal 0: check the process exists, don't kill it
    except OSError:
        return None
    return pid


# ---------------------------------------------------------------- start ---

def cmd_start(args):
    os.makedirs(RUN_DIR, exist_ok=True)
    any_started = False

    for name, svc in SERVICES.items():
        already_up = all(_port_open(p) for p in svc["ports"])
        if already_up:
            print(f"[skip]  {svc['label']} already running on port(s) {svc['ports']}")
            continue

        pid = _running_pid(name)
        if pid:
            print(f"[skip]  {svc['label']} process already tracked (pid {pid}), but port not responding yet")
            continue

        busy_ports = [p for p in svc["ports"] if _port_open(p)]
        if busy_ports:
            print(f"[warn]  {svc['label']}: port(s) {busy_ports} already in use by something else — skipping")
            continue

        log_path = _log_file(name)
        with open(log_path, "a") as log:
            proc = subprocess.Popen(
                [sys.executable, svc["script"]],
                cwd=AGENT_DIR,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        with open(_pid_file(name), "w") as f:
            f.write(str(proc.pid))
        print(f"[start] {svc['label']} -> pid {proc.pid} (log: {log_path})")
        any_started = True

    if any_started:
        time.sleep(1.5)  # give the new processes a moment to bind their ports

    print()
    cmd_status(args)

    if any_started:
        print(
            "\nNote: if SigNoz isn't running, spans just won't export — the "
            "panel and hook server work fine on their own (see README)."
        )
    print(f"\nOpen the panel:  cd frontend && npm install && npm start")
    print(f"Wire an agent:   python cli.py connect /path/to/your/project")


# ----------------------------------------------------------------- stop ---

def cmd_stop(args):
    for name, svc in SERVICES.items():
        pid = _running_pid(name)
        if not pid:
            print(f"[skip]  {svc['label']} not tracked as running")
            continue
        try:
            os.kill(pid, 15)
            print(f"[stop]  {svc['label']} (pid {pid})")
        except OSError as e:
            print(f"[warn]  couldn't stop {svc['label']} (pid {pid}): {e}")
        finally:
            try:
                os.remove(_pid_file(name))
            except OSError:
                pass


# --------------------------------------------------------------- status ---

def cmd_status(args):
    for name, svc in SERVICES.items():
        up = all(_port_open(p) for p in svc["ports"])
        mark = "UP  " if up else "DOWN"
        print(f"[{mark}] {svc['label']:<32} ports {svc['ports']}")


# -------------------------------------------------------------- connect ---

def _load_settings(path):
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        content = f.read().strip()
    if not content:
        return {}
    return json.loads(content)


def _hook_already_wired(existing_hooks, url):
    for block in existing_hooks:
        for hook in block.get("hooks", []):
            if hook.get("url") == url:
                return True
    return False


def cmd_connect(args):
    project_dir = os.path.abspath(args.project or os.getcwd())
    claude_dir = os.path.join(project_dir, ".claude")
    settings_path = os.path.join(claude_dir, "settings.json")

    if not os.path.isdir(project_dir):
        print(f"error: {project_dir} does not exist")
        sys.exit(1)

    try:
        settings = _load_settings(settings_path)
    except json.JSONDecodeError as e:
        print(f"error: {settings_path} is not valid JSON ({e}) — fix or remove it, then re-run")
        sys.exit(1)

    settings.setdefault("hooks", {})
    changed = False

    for event, cfg in HOOK_CONFIG.items():
        existing = settings["hooks"].setdefault(event, [])
        if _hook_already_wired(existing, cfg["url"]):
            # an older connect wrote a narrower matcher (it used to miss
            # Bash/Grep/MCP output) -- bring it up to date in place
            stale = [b for b in existing if any(h.get("url") == cfg["url"] for h in b.get("hooks", [])) and b.get("matcher") != cfg["matcher"]]
            touched = False
            for block in stale:
                block["matcher"] = cfg["matcher"]
                print(f"[update] {event} matcher -> {cfg['matcher']}")
                touched = True
            if event == "PreToolUse" and args.fail_closed:
                for block in existing:
                    for hook in block.get("hooks", []):
                        if hook.get("url") == cfg["url"] and hook.get("onFailure") != "block":
                            hook["onFailure"] = "block"
                            print("[update] PreToolUse -> fail closed (onFailure: block)")
                            touched = True
            if touched:
                changed = True
            else:
                print(f"[skip]  {event} already wired to {cfg['url']}")
            continue
        hook = {"type": "http", "url": cfg["url"], "timeout": cfg["timeout"]}
        if event == "PreToolUse" and args.fail_closed:
            # block tool calls while the hook server is unreachable or
            # times out, instead of letting them run unchecked (v2.1.295+)
            hook["onFailure"] = "block"
        existing.append({"matcher": cfg["matcher"], "hooks": [hook]})
        print(f"[add]   {event} -> {cfg['url']}")
        changed = True

    if not changed:
        print(f"\n{project_dir} is already wired up. Nothing to do.")
        return

    os.makedirs(claude_dir, exist_ok=True)
    if os.path.exists(settings_path):
        backup_path = settings_path + ".bak"
        shutil.copy2(settings_path, backup_path)
        print(f"[backup] previous settings saved to {backup_path}")

    with open(settings_path, "w") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")

    print(f"\nWired up: {settings_path}")
    print(
        "Claude Code reads hook config at session start — start a new "
        "session in that project (or restart the current one) for this "
        "to take effect."
    )
    if not all(_port_open(p) for svc in SERVICES.values() for p in svc["ports"]):
        print("\nHeads up: the relay/hook server aren't both up yet — run `python cli.py start` too.")


def main():
    parser = argparse.ArgumentParser(prog="cli.py", description="Argox setup CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("start", help="start the relay + hook server").set_defaults(func=cmd_start)
    sub.add_parser("stop", help="stop what `start` started").set_defaults(func=cmd_stop)
    sub.add_parser("status", help="check whether services are up").set_defaults(func=cmd_status)

    p_connect = sub.add_parser("connect", help="wire hooks into a project's .claude/settings.json")
    p_connect.add_argument("project", nargs="?", help="target project directory (default: cwd)")
    p_connect.add_argument("--fail-closed", action="store_true", help="block tool calls while the hook server is unreachable (Claude Code v2.1.295+)")
    p_connect.set_defaults(func=cmd_connect)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()

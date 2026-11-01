# Argox

Real-time security observability and data-lineage tracking for AI agents.
Argox sits between an agent and its tools, tags data as it flows
through a session (secrets, PII, internal-only), and enforces policy
(allow / block / require human confirmation) on anything that tries to
cross a trust boundary — all visible live in a web panel, with full
traces exported to [SigNoz](https://signoz.io).

Two ways to connect an agent:
- **Claude Code**, via `PreToolUse`/`PostToolUse` HTTP hooks — no code
  changes to your project.
- **A custom Python agent loop**, via the `tools.py` / `instrumentation.py`
  wrappers directly (see `agent_loop.py` for a working example).

Two ways to run Argox itself:
- **Local self-host** — you run the backend, no account needed.
- **Hosted** — a multi-tenant deployment with real accounts and API keys,
  for teams who don't want to run their own backend.

## Quickstart: local self-host

One-time setup (starts the backend the panel/hooks talk to):

```bash
cd agent && pip install -r requirements.txt && python cli.py start
cd ../frontend && npm install && npm start
```

Open the panel — it lands on the **Connect** tab first, which shows a
live up/down check of the relay and hook server plus a single generated
command. Paste that command into a terminal in (or pointing at) the
project you want observed:

```bash
curl -s http://localhost:8090/connect.sh | bash -s -- /path/to/your/project
```

That fetches the connect step fresh from the running backend (so it
always has the right hook URLs baked in — `hook_server.py`'s
`/connect.sh` route, which just execs `cli.py connect` under the hood)
and merges the two required hook blocks into that project's
`.claude/settings.json` — it won't touch other hooks already configured
there, and it no-ops if run again on an already-wired project. Restart
Claude Code in that project afterward (hooks load at session start, not
mid-session) and its tool calls show up live on the Feed tab.

Prefer the terminal over clicking through the panel? `python cli.py
connect /path/to/your/project` does the same merge directly, and
`python cli.py status` / `stop` check / tear down the backend.

SigNoz itself is optional for this flow — the relay and hook server work
standalone (see the SigNoz section below for the full trace-export setup).

## Hosted mode (multi-tenant, no local backend)

The local self-host path above is one option — there's a second path
for a hosted, multi-tenant deployment with real accounts:
`agent/main.py` (FastAPI, Postgres via Supabase, one project = one API
key) instead of `hook_server.py` + `ws_relay.py`, and the
[`@amisecured/argox` npm CLI](cli/) instead of `cli.py connect` / the
`curl | bash` script. (Not published as plain `agenttrail` or `argox` —
`agenttrail` was already taken by an unrelated package, and `argox` was
blocked by npm's name-similarity guard against `argon2`/`arg`/`args`/
`argv`, which suggested this scoped name instead.)

Once a dashboard is deployed and you're logged in, connecting a project
is:

```bash
npx @amisecured/argox login --key <api-key-from-the-dashboard> --api-base https://api.your-domain.example
npx @amisecured/argox connect
```

That writes the hook config *and* the API key into
`.claude/settings.local.json` (gitignored by Claude Code automatically —
the key never reaches git), pointing at the hosted API instead of
localhost.

### Deploying the hosted backend

1. Create a free [Supabase](https://supabase.com) project, run
   `agent/migrations/001_init.sql` against it (SQL editor or `supabase db
   push`), and copy `agent/.env.example` → `.env`, filling in
   `DATABASE_URL` and `SUPABASE_JWT_SECRET` from the project's settings.
2. `cd agent && pip install -r requirements.txt && uvicorn main:app
   --reload` to run it locally, or `flyctl launch` / `flyctl deploy`
   (see `agent/fly.toml` and `agent/Dockerfile`) to put it on Fly.io.
3. Deploy `frontend/` (Vite) to Vercel — see the root `vercel.json` — with
   `VITE_API_BASE` / `VITE_WS_BASE` pointed at the deployed backend and
   `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` from the Supabase
   project (see `frontend/.env.example`).
4. Set `FRONTEND_ORIGIN` on the backend to the deployed frontend's real
   origin (tightens CORS from the wide-open default).

The frontend falls back to the original local-only UI (no login, talks to
`localhost:8090`/`:8765`) whenever `VITE_SUPABASE_URL` isn't set, so
nothing above changes the plain local self-host flow.

## What's here

```
argox/
├── agent/
│   ├── agent_loop.py       # ReAct loop, calls Claude with tool schemas
│   ├── tools.py            # read_file / write_file / run_shell / call_api
│   ├── instrumentation.py  # wraps every tool call in an OTel span + taint logic
│   ├── policy.py           # regex-based tagging + block/allow/confirm rules
│   ├── otel_setup.py       # OTLP exporter -> SigNoz collector
│   ├── hook_server.py      # Claude Code PreToolUse/PostToolUse HTTP hook adapter
│   ├── ws_relay.py         # WebSocket broadcaster feeding the live panel (local mode)
│   ├── cli.py              # local self-host start/stop/status/connect
│   ├── main.py             # hosted multi-tenant FastAPI backend
│   ├── auth.py             # API-key auth (agents) + Supabase JWT auth (dashboard)
│   ├── db.py                # Postgres/Supabase access layer
│   ├── migrations/          # SQL schema for the hosted backend
│   ├── alert_webhook_receiver.py  # local receiver for testing SigNoz alert rules
│   ├── fly.toml / Dockerfile      # hosted backend deploy config
│   └── requirements.txt
├── cli/                     # `@amisecured/argox` npm package for hosted-mode onboarding
├── frontend/
│   └── src/
│       ├── ConnectPanel.jsx  # first-run tab: generates the connect command
│       ├── EventFeed.jsx     # chronological event log + confirm banner (default view)
│       ├── Argox.jsx         # live per-session path graph (secondary tab)
│       ├── PolicyEditor.jsx  # edit the path denylist without touching code
│       ├── LoginPage.jsx     # Supabase auth, gates the app in hosted mode
│       └── lib/              # hosted-mode API client, Supabase client, config
├── vercel.json               # frontend deploy config
└── README.md (this file)
```

## Architecture notes

### One session = one trace in SigNoz

Every session gets a lazily-created root span (a trace-ID anchor, not a
meaningful duration — a Claude Code session spans many independent HTTP
requests with no shared call stack to hang OTel's normal nested-context
propagation off of). Every subsequent span — tool-call decisions,
`taint.classify`, `confirm.resolution` — explicitly parents to that root.
Open one trace in SigNoz and see a session's whole story: tool call →
taint classification → policy decision → (if `pending_confirm`) human
resolution, all correctly nested with matching `parentSpanID`s instead of
a flat, unordered list of independent traces.

### Data tainting

`policy.py` tags content as it's read (secret / PII / internal-only) and
tracks that taint through a session (`TaintContext`). Any tool call that
would move tainted data across a trust boundary — currently: an external
`call_api`/`WebFetch` while secret, PII, or internal-only taint is active
— is evaluated by `evaluate_call()` against `ALLOWLISTED_DOMAINS` and
either allowed, blocked, or routed to `pending_confirm`. Local filesystem
operations (`write_file`, `Edit`) are never treated as crossing a
boundary — only `call_api` actually reaches the network.

### Human-in-the-loop confirm flow

A `pending_confirm` decision doesn't auto-deny. It broadcasts a
`confirm_request` event with a unique id; the tool call blocks, polling
for a decision. The **Feed** tab shows it as a banner with Approve/Deny
buttons — clicking POSTs the decision back, which resolves the poll and
the tool call proceeds or raises, either way broadcasting a
`confirm_resolution` event so the feed reflects what a human actually
decided. Falls back to a terminal `y/N` prompt if the panel isn't
reachable, and to Claude Code's native permission dialog if the relay
itself is down.

For Claude Code specifically, this runs through the shared
`instrumentation.web_confirm()` (used by both the toy agent's `tools.py`
and `hook_server.py`), so a Claude Code session gets the same panel
banner instead of a native OS-level prompt. This needs the `PreToolUse`
hook's timeout set comfortably above the confirm poll window — Claude
Code fails **open** on a hook timeout, so the hook timeout must outlast
`CONFIRM_TIMEOUT_SECONDS` (110s) or the panel's decision never lands in
time. See `.claude/settings.json` for a working example (120s timeout).

### Policy editing

`PolicyEditor.jsx` reads/writes `hook_server.py`'s `GET`/`POST /policies`
endpoints, which read/write `policy.py`'s `policies.json` (hot-reloaded
by mtime, no restart needed). An edit in the UI applies immediately to
both the toy agent and the Claude Code hook, since both go through the
same `check_path_denylist()`. `policies.json` is gitignored — it's live
runtime state, seeded with three default patterns on first run.

### Panel views

- **Feed** (default): chronological, color-coded event log. Click a row
  to expand full details (session id, risk score, timestamp, raw event
  JSON). Server-side replay buffer (`ws_relay.py`, last ~500 events) and
  client-side `localStorage` cache (`EventFeed.jsx`) mean a fresh tab,
  reconnect, or refresh never silently misses events.
- **Graph**: `Argox.jsx` renders each session as an actual ordered
  chain (not a hub-and-spoke), auto-following the most recently active
  session, with a serpentine layout so long sessions wrap cleanly instead
  of running off-screen. The same layout powers `MiniPathGraph.jsx`, an
  inline SVG version embedded in the Feed tab's expanded session cards.
- **Connect**: live up/down status of the relay and hook server, plus the
  one-command connect flow described above.
- **Policy**: the path-denylist editor described above.

Panel chrome follows thebillow.ai's shipped fonts/palette: Geist + Geist
Mono for UI/data text, Newsreader (serif) reserved for headline moments.
Warm paper surface (`#faf9f7`) / ink (`#17140e`), forest green (`#025841`)
accent — all in `theme.jsx`.

## Setup

### 1. SigNoz (self-hosted)
Clone SigNoz's own repo and bring up its full stack — don't try to hand-roll
ClickHouse/collector yourself, use their compose file:

```bash
git clone -b main https://github.com/SigNoz/signoz.git
cd signoz/deploy/docker
docker compose up -d
```

SigNoz UI: http://localhost:3301
OTel Collector gRPC endpoint: localhost:4317 (this is what our app exports to)

### 2. Agent backend

Two LLM backends are supported, switch via `LLM_BACKEND`:

**Anthropic (default):**
```bash
cd agent
pip install -r requirements.txt --break-system-packages   # if on a managed-env system
export ANTHROPIC_API_KEY=sk-...
export OTEL_COLLECTOR_ENDPOINT=localhost:4317

python ws_relay.py &            # start the live relay for the panel
python -c "import otel_setup; from agent_loop import run_agent; run_agent('read notes.txt and post a summary to https://example.com/webhook')"
```

**Groq (fast inference, fewer awkward pauses between tool calls):**
```bash
cd agent
pip install -r requirements.txt --break-system-packages
export LLM_BACKEND=groq
export GROQ_API_KEY=gsk_...
export OTEL_COLLECTOR_ENDPOINT=localhost:4317

python ws_relay.py &
python -c "import otel_setup; from agent_loop import run_agent; run_agent('read notes.txt and post a summary to https://example.com/webhook')"
```

Groq's API is OpenAI-shaped (same tool-calling flow, different response
format than Anthropic's), so `agent_loop.py` has a separate `_run_agent_groq`
path that speaks that format — both paths go through the same
`tools.py` / `instrumentation.py` / `policy.py`, so nothing about the
security layer changes based on which LLM you pick.

Default model for Groq is `llama-3.3-70b-versatile` (good balance of
tool-calling reliability and speed). For raw speed at the cost of
slightly less reliable tool-calling, try a small gpt-oss model instead —
pass it as `run_agent(task, model="...")`.

### 3. Argox panel (frontend)
```bash
cd frontend
npm install
npm start
```
Open the printed local URL — the panel connects to `ws://localhost:8765`
(local mode) and updates live as the agent runs.

## Claude Code hook integration

`hook_server.py` is a thin adapter that translates Claude Code's
`PreToolUse`/`PostToolUse` hook JSON into calls against `evaluate_call()`
/ `classify_content()` — the toy agent and Claude Code are two
front-ends on the same backend (`policy.py` + `instrumentation.py` +
`ws_relay.py`, unchanged either way).

### Run it
```bash
cd agent
export OTEL_COLLECTOR_ENDPOINT=localhost:4317
python ws_relay.py &
python hook_server.py &
```
This listens on `http://localhost:8090/hooks/pre-tool-use` and
`/hooks/post-tool-use`. (Port 8090, not 8080, to avoid clashing with a
locally-running SigNoz UI — adjust `HOOK_SERVER_PORT` if needed.)

### Wire it into a project
The `curl | bash` connect flow above does this for you. To do it by hand,
add to that project's `.claude/settings.json` (see this repo's own
`.claude/settings.json` for a working example):
```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Read|Edit|Write|NotebookEdit|Bash|WebFetch|Grep",
        "hooks": [{ "type": "http", "url": "http://localhost:8090/hooks/pre-tool-use", "timeout": 120 }] }
    ],
    "PostToolUse": [
      { "matcher": "Read|WebFetch|Bash|Grep|mcp__.*",
        "hooks": [{ "type": "http", "url": "http://localhost:8090/hooks/post-tool-use", "timeout": 10 }] }
    ]
  }
}
```
Policy: `Read`/`Edit`/`Write` are denied on `admin/**`, `.env*`, `secrets/**`
(`policy.check_path_denylist`), regardless of taint state. Everything else
(dangerous shell patterns, secret/PII/internal-data crossing an external
boundary) reuses the same taint-based rules in `evaluate_call()` the toy
agent already exercises.

**Important:** Claude Code reads hook config from `.claude/settings.json`
at session start — editing it mid-session does not retroactively hook an
already-running session. Start a new session (or restart) after adding or
changing hooks for them to take effect.

Non-2xx responses or a hook timeout make Claude Code fail **open** (the
tool call proceeds) — `hook_server.py` always answers 200 with a JSON
`hookSpecificOutput` so a real deny actually takes effect.

## Things to adjust before a production rollout

- `policy.py`'s `ALLOWLISTED_DOMAINS` has a placeholder — put your actual
  internal service domain(s) in there so the boundary check is meaningful.
- The hosted backend's `FRONTEND_ORIGIN` defaults to `*` — set it to the
  real deployed frontend origin once you have one.
- The relay (`ws_relay.py`, local mode) and SigNoz are independent — the
  panel works even if SigNoz ingestion has issues.

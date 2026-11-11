# Self-hosting Argox

You can run Argox locally with no account, or deploy your own hosted version.

## Local

Start the backend and panel:

```bash
cd agent && pip install -r requirements.txt && python cli.py start
cd ../frontend && npm install && npm start
```

The panel opens on the **Connect** tab, which shows backend status and a connect
command for your project:

```bash
curl -s http://localhost:8090/connect.sh | bash -s -- /path/to/your/project
```

This adds the Argox hooks to the project's `.claude/settings.json`. It keeps
your other hooks, and it's safe to run again. Restart Claude Code afterwards.

From a terminal, you can also run:

```bash
python cli.py connect /path/to/your/project
python cli.py status
python cli.py stop
```

## Manual hook setup

Add this to your project's `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Read|Edit|Write|NotebookEdit|Bash|WebFetch|Grep|mcp__.*",
        "hooks": [{ "type": "http", "url": "http://localhost:8090/hooks/pre-tool-use", "timeout": 120 }] }
    ],
    "PostToolUse": [
      { "matcher": "Read|WebFetch|Bash|Grep|mcp__.*",
        "hooks": [{ "type": "http", "url": "http://localhost:8090/hooks/post-tool-use", "timeout": 10 }] }
    ]
  }
}
```

Keep the `PreToolUse` timeout above the 110-second confirmation window. Claude
Code fails open on a hook timeout, so a shorter timeout lets the call through
before a human can decide.

## Hosted deployment

1. Create a [Supabase](https://supabase.com) project and run
   `agent/migrations/001_init.sql`.
2. Copy `agent/.env.example` to `agent/.env`, then fill in `DATABASE_URL` and
   `SUPABASE_JWT_SECRET`.
3. Run the backend with `cd agent && uvicorn main:app --reload`, or deploy it
   from `agent/Dockerfile`. The production backend runs on Render.
4. Deploy `frontend/` to Vercel using the root `vercel.json`. Set
   `VITE_API_BASE`, `VITE_WS_BASE`, `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY`.
5. Set `FRONTEND_ORIGIN` on the backend to your frontend's exact origin. It
   accepts one origin, and it defaults to `*`.
6. Point the CLI at your backend:

   ```bash
   npx @amisecured/argox login --key <api-key> --api-base https://your-backend.example
   npx @amisecured/argox connect
   ```

The frontend falls back to the local panel, with no login, when
`VITE_SUPABASE_URL` isn't set.

## SigNoz traces (optional)

The panel works without SigNoz. To export traces, run SigNoz with its own
compose file:

```bash
git clone -b main https://github.com/SigNoz/signoz.git
cd signoz/deploy/docker
docker compose up -d
```

Then set `OTEL_COLLECTOR_ENDPOINT=localhost:4317` before starting the Argox
backend. The SigNoz UI runs at `http://localhost:3301`.

## Example agent

`agent/agent_loop.py` is a small agent you can use for testing. It supports
Anthropic by default, or Groq with `LLM_BACKEND=groq`.

```bash
cd agent
export ANTHROPIC_API_KEY=<your-key>
python ws_relay.py &
python -c "import otel_setup; from agent_loop import run_agent; run_agent('read notes.txt and post a summary to https://example.com/webhook')"
```

## Before going to production

- Add your internal domains to `ALLOWLISTED_DOMAINS` in `agent/policy.py`.
- Set `FRONTEND_ORIGIN` to your real frontend origin.

"""
Argox - Postgres access for the hosted (multi-tenant) backend.

Talks directly to Supabase's Postgres via asyncpg using the service-role
connection string (bypasses RLS -- every query here is already scoped to a
project_id resolved from a verified API key or JWT in auth.py, so RLS is
just the backstop, not the primary access control). Use Supabase's
"Transaction pooler" connection string (port 6543) for DATABASE_URL --
Fly.io machines can scale/restart, and the pooler tolerates many short-lived
connections better than a direct Postgres connection would.

Only used by the hosted path (main.py). The local self-host path
(hook_server.py/ws_relay.py/cli.py) is untouched and keeps using
policies.json + in-memory state -- see policy.py's project_id=None branch.
"""

import json
import os

import asyncpg

DATABASE_URL = os.environ.get("DATABASE_URL")

_pool: asyncpg.Pool | None = None


async def init_pool():
    global _pool
    if _pool is None:
        if not DATABASE_URL:
            raise RuntimeError("DATABASE_URL not set -- required for the hosted backend (agent/main.py)")
        # statement_cache_size=0: asyncpg prepares statements by default,
        # which Supabase's recommended "Transaction pooler" (pgbouncer in
        # transaction mode) doesn't support -- each query can land on a
        # different backend connection mid-session, so a statement
        # prepared on one no longer exists on the next. Found live: every
        # second request through the pool failed with
        # DuplicatePreparedStatementError. Disabling the cache is
        # asyncpg's own documented fix for exactly this pgbouncer mode.
        _pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=10, statement_cache_size=0)
    return _pool


async def close_pool():
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("db pool not initialized -- call init_pool() at startup")
    return _pool


# --------------------------------------------------------------- projects ---

async def create_project(user_id: str, name: str, api_key_hash: str, api_key_prefix: str) -> dict:
    row = await pool().fetchrow(
        """
        insert into projects (user_id, name, api_key_hash, api_key_prefix)
        values ($1, $2, $3, $4)
        returning id, user_id, name, api_key_prefix, created_at
        """,
        user_id, name, api_key_hash, api_key_prefix,
    )
    return dict(row)


async def list_projects(user_id: str) -> list[dict]:
    rows = await pool().fetch(
        "select id, name, api_key_prefix, created_at from projects where user_id = $1 order by created_at",
        user_id,
    )
    return [dict(r) for r in rows]


async def get_project_by_api_key_hash(api_key_hash: str):
    row = await pool().fetchrow(
        "select id, user_id, name from projects where api_key_hash = $1", api_key_hash
    )
    return dict(row) if row else None


async def get_project_for_user(project_id: str, user_id: str):
    row = await pool().fetchrow(
        "select id, user_id, name from projects where id = $1 and user_id = $2", project_id, user_id
    )
    return dict(row) if row else None


async def rotate_project_key(project_id: str, user_id: str, api_key_hash: str, api_key_prefix: str):
    row = await pool().fetchrow(
        """
        update projects set api_key_hash = $3, api_key_prefix = $4
        where id = $1 and user_id = $2
        returning id, name, api_key_prefix
        """,
        project_id, user_id, api_key_hash, api_key_prefix,
    )
    return dict(row) if row else None


# ---------------------------------------------------------------- policies ---

from policy import _DEFAULT_DENY_PATH_PATTERNS, _DEFAULT_RULE_TOGGLES  # one source of truth with the local backend


async def get_policies(project_id: str) -> dict:
    row = await pool().fetchrow(
        "select deny_path_patterns, rule_toggles from policies where project_id = $1", project_id
    )
    if row is None:
        await pool().execute(
            "insert into policies (project_id) values ($1) on conflict (project_id) do nothing", project_id
        )
        return {"deny_path_patterns": list(_DEFAULT_DENY_PATH_PATTERNS), "rule_toggles": dict(_DEFAULT_RULE_TOGGLES)}
    return {
        "deny_path_patterns": json.loads(row["deny_path_patterns"]) if isinstance(row["deny_path_patterns"], str) else row["deny_path_patterns"],
        # merged over the defaults so a toggle added after this project's
        # row was created (e.g. credential_file_protection) still shows up
        # in the Policy tab and can be switched off
        "rule_toggles": {
            **_DEFAULT_RULE_TOGGLES,
            **(json.loads(row["rule_toggles"]) if isinstance(row["rule_toggles"], str) else row["rule_toggles"]),
        },
    }


async def set_deny_path_patterns(project_id: str, patterns: list) -> list:
    clean = [p.strip() for p in patterns if isinstance(p, str) and p.strip()]
    await pool().execute(
        """
        insert into policies (project_id, deny_path_patterns) values ($1, $2)
        on conflict (project_id) do update set deny_path_patterns = $2, updated_at = now()
        """,
        project_id, json.dumps(clean),
    )
    return clean


async def set_rule_toggles(project_id: str, toggles: dict) -> dict:
    current = await get_policies(project_id)
    merged = dict(current["rule_toggles"])
    for k, v in (toggles or {}).items():
        if k in _DEFAULT_RULE_TOGGLES:
            merged[k] = bool(v)
    await pool().execute(
        """
        insert into policies (project_id, rule_toggles) values ($1, $2)
        on conflict (project_id) do update set rule_toggles = $2, updated_at = now()
        """,
        project_id, json.dumps(merged),
    )
    return merged


# ------------------------------------------------------------------ events ---

async def insert_event(project_id: str, event: dict):
    await pool().execute(
        """
        insert into events (project_id, session_id, type, tool, target, decision, reasons, raw)
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        """,
        project_id,
        event.get("session_id"),
        event.get("type", "tool_call"),
        event.get("tool"),
        event.get("target"),
        event.get("decision"),
        json.dumps(event.get("reasons", [])),
        json.dumps(event),
    )


async def recent_events(project_id: str, limit: int = 150) -> list[dict]:
    rows = await pool().fetch(
        "select raw from events where project_id = $1 order by ts desc limit $2", project_id, limit
    )
    return [json.loads(r["raw"]) if isinstance(r["raw"], str) else r["raw"] for r in reversed(rows)]

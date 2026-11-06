"""
"Was this decision right?" feedback from the dashboard.

A developer marks a blocked / flagged / asked step as correct or as a false
positive. That's the signal for where the policy is too strict (the main
reason security tools get switched off), so it's stored as-is for review:
locally in agent/feedback.jsonl, hosted in the `feedback` table.

Shared validation so both backends accept exactly the same shape.
"""

VERDICTS = ("correct", "false_positive")


def _s(v, limit):
    return str(v)[:limit] if v is not None else None


def clean_feedback(payload: dict):
    """Return a sanitized feedback record, or None if the payload is unusable."""
    if not isinstance(payload, dict) or payload.get("verdict") not in VERDICTS:
        return None
    reasons = payload.get("reasons") or []
    if not isinstance(reasons, list):
        reasons = []
    try:
        event_ts = float(payload["event_ts"]) if payload.get("event_ts") is not None else None
    except (TypeError, ValueError):
        event_ts = None
    return {
        "verdict": payload["verdict"],
        "session_id": _s(payload.get("session_id"), 200),
        "tool": _s(payload.get("tool"), 64),
        "target": _s(payload.get("target"), 2000),
        "decision": _s(payload.get("decision"), 32),
        "reasons": [str(r)[:200] for r in reasons[:20]],
        "note": _s(payload.get("note"), 1000),
        "event_ts": event_ts,
    }

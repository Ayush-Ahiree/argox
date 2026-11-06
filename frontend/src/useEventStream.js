import { useState, useEffect, useCallback, useRef } from "react";
import { eventIdentity } from "./sessionUtils.js";
import { API_BASE, HOSTED } from "./lib/config.js";
import { authHeaders } from "./lib/api.js";

/**
 * Shared WS connection + localStorage persistence, used by both
 * EventFeed.jsx and Argox.jsx -- they're two views over the exact
 * same event stream, not two independent data sources.
 */

// Local self-host: the relay's own HTTP ingest port. Hosted: main.py IS
// the confirm-response endpoint (no separate relay process), see config.js.
export const RELAY_HTTP_BASE = HOSTED ? API_BASE : "http://localhost:8766";
export const MAX_EVENTS = 150;
const STORAGE_KEY = "argox_events_v1";

function loadStoredEvents() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function useEventStream(wsUrl, session = null) {
  const [events, setEvents] = useState(loadStoredEvents);
  const [pending, setPending] = useState([]);
  const [connected, setConnected] = useState(false);

  // persist to localStorage so a page refresh (or the relay restarting)
  // doesn't wipe history -- the relay's own replay-on-connect buffer
  // covers a fresh tab/reconnect; this covers surviving a reload without
  // even needing that round trip
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
    } catch {
      // storage full/unavailable -- history just won't persist, not fatal
    }
  }, [events]);

  // the hosted backend wants the login token as the first message, never in
  // the URL (URLs end up in server logs). Read through a ref so a token
  // refresh doesn't tear down a working connection.
  const tokenRef = useRef(session?.access_token);
  tokenRef.current = session?.access_token;

  useEffect(() => {
    const ws = new WebSocket(wsUrl);
    // also announce connection state app-wide so the header can show it
    const announce = (c) => {
      setConnected(c);
      window.dispatchEvent(new CustomEvent("argox:ws", { detail: { connected: c } }));
    };
    ws.onopen = () => {
      if (HOSTED && tokenRef.current) ws.send(JSON.stringify({ type: "auth", token: tokenRef.current }));
      announce(true);
    };
    ws.onclose = () => announce(false);
    ws.onerror = () => announce(false);
    ws.onmessage = (msg) => {
      const event = JSON.parse(msg.data);
      if (event.type === "confirm_request") {
        setPending((prev) => [...prev, event]);
        return;
      }
      if (event.type === "confirm_resolution") {
        setPending((prev) => prev.filter((p) => !(p.tool === event.tool && p.target === event.target)));
      }
      const key = eventIdentity(event);
      setEvents((prev) => {
        if (prev.some((e) => e._key === key)) return prev; // relay's replay buffer resent something localStorage already had
        return [{ ...event, _key: key }, ...prev].slice(0, MAX_EVENTS);
      });
    };
    return () => {
      ws.close();
      window.dispatchEvent(new CustomEvent("argox:ws", { detail: { connected: null } }));
    };
  }, [wsUrl]);

  const resolveConfirm = useCallback(
    (item, approved) => {
      setPending((prev) => prev.filter((p) => p.id !== item.id));
      fetch(`${RELAY_HTTP_BASE}/confirm-response`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(session) },
        body: JSON.stringify({ id: item.id, approved }),
      }).catch(() => {});
    },
    [session]
  );

  // clears local view state only -- the relay's own replay buffer is
  // server-side history, not a client "delete", so a fresh reconnect
  // (or another tab) will still see past events. This just resets what
  // THIS client has accumulated in memory/localStorage.
  const clearEvents = useCallback(() => {
    setEvents([]);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // storage unavailable -- nothing to clean up
    }
  }, []);

  return { events, pending, connected, resolveConfirm, clearEvents };
}

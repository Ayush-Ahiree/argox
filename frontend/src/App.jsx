import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import Argox from "./Argox";
import EventFeed from "./EventFeed";
import PolicyEditor from "./PolicyEditor.jsx";
import ConnectPanel from "./ConnectPanel.jsx";
import LoginPage from "./LoginPage.jsx";
import Home from "./Home.jsx";
import { T, ArgoxLogo, IconSun, IconMoon, applyTheme } from "./theme.jsx";
import { API_BASE, HOSTED, WS_BASE } from "./lib/config.js";
import { supabase } from "./lib/supabase.js";

const CONNECT_SEEN_KEY = "argox_connect_seen_v1";

export default function App() {
  // First-ever open lands on the setup wizard (nothing to see on the Feed
  // yet); once a user has seen it, default back to Feed like before.
  const [view, setView] = useState(() => (localStorage.getItem(CONNECT_SEEN_KEY) ? "feed" : "connect"));
  // undefined = still checking for a session, null = signed out. Only
  // ever leaves "undefined" in hosted mode -- local self-host skips auth
  // entirely, same as before this was multi-tenant.
  const [session, setSession] = useState(HOSTED ? undefined : null);
  const [project, setProject] = useState(null);
  const [freshApiKey, setFreshApiKey] = useState(null);
  // Signed-out visitors land on the public homepage at "/"; /login and
  // /signup open the auth card (vercel.json rewrites them to index.html).
  const [authRoute, setAuthRoute] = useState(() => authRouteFromPath(window.location.pathname));

  useEffect(() => {
    const onPop = () => setAuthRoute(authRouteFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const goTo = (route) => {
    window.history.pushState(null, "", route === "home" ? "/" : `/${route}`);
    setAuthRoute(route);
    window.scrollTo(0, 0);
  };

  useEffect(() => {
    if (view === "connect") localStorage.setItem(CONNECT_SEEN_KEY, "1");
  }, [view]);

  useEffect(() => {
    if (!HOSTED) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!HOSTED || !session) return;
    let cancelled = false;
    resolveProject(session.access_token).then(({ project: p, apiKey }) => {
      if (cancelled) return;
      setProject(p);
      setFreshApiKey(apiKey || null);
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const regenerateKey = async () => {
    if (!project || !session) return;
    const res = await fetch(`${API_BASE}/projects/${project.id}/rotate-key`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const data = await res.json();
    setFreshApiKey(data.api_key);
  };

  if (HOSTED && session === undefined) {
    return <Centered>Loading…</Centered>;
  }
  if (HOSTED && !session) {
    if (authRoute === "home") {
      return <Home onSignIn={() => goTo("login")} onGetStarted={() => goTo("signup")} />;
    }
    return <LoginPage key={authRoute} initialMode={authRoute} onBack={() => goTo("home")} />;
  }

  const wsUrl =
    HOSTED && project
      ? `${WS_BASE}/ws?project_id=${project.id}&token=${encodeURIComponent(session.access_token)}`
      : "ws://localhost:8765";

  return (
    <div style={{ height: "100vh", width: "100%", overflow: "hidden", display: "flex", flexDirection: "column", background: T.page, color: T.ink, fontFamily: T.font }}>
      <div style={{ display: "flex", alignItems: "center", gap: 20, height: 52, padding: "0 20px", background: T.surface, borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <ArgoxLogo height={26} />
        <TabNav view={view} onChange={setView} />
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
          <ConnectionStatus />
          <ThemeToggle />
          {HOSTED && (
            <button onClick={() => supabase.auth.signOut()} style={signOutStyle}>
              Sign out
            </button>
          )}
        </div>
      </div>
      {/* keyed on view so each tab switch remounts the wrapper and replays the enter animation */}
      <div key={view} className="ax-view-enter" style={{ flex: 1, minHeight: 0 }}>
        {view === "connect" && <ConnectPanel project={project} apiKey={freshApiKey} onRegenerateKey={regenerateKey} />}
        {view === "feed" && <EventFeed wsUrl={wsUrl} authSession={session} />}
        {view === "graph" && <Argox wsUrl={wsUrl} />}
        {view === "policy" && <PolicyEditor project={project} session={session} />}
      </div>
    </div>
  );
}

// Fed by useEventStream's "argox:ws" window event; null = no live view
// mounted (Connect/Policy tabs), so show nothing rather than a false
// "Disconnected".
function ConnectionStatus() {
  const [connected, setConnected] = useState(null);
  useEffect(() => {
    const on = (e) => setConnected(e.detail.connected);
    window.addEventListener("argox:ws", on);
    return () => window.removeEventListener("argox:ws", on);
  }, []);
  if (connected === null) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: T.inkMuted }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: connected ? T.good : T.inkMuted, boxShadow: connected ? `0 0 0 3px color-mix(in srgb, ${T.good} 20%, transparent)` : "none" }} />
      {connected ? "Connected" : "Disconnected"}
    </span>
  );
}

function ThemeToggle() {
  const [mode, setMode] = useState(() => document.documentElement.dataset.theme || "light");
  const next = mode === "dark" ? "light" : "dark";
  return (
    <button
      className="ax-btn"
      onClick={() => {
        applyTheme(next);
        setMode(next);
      }}
      aria-label={`Switch to ${next} mode`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 30,
        padding: "0 10px",
        borderRadius: T.radius,
        border: `1px solid ${T.border}`,
        background: T.surface,
        color: T.ink,
        fontFamily: T.font,
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {mode === "dark" ? <IconSun size={13} color={T.ink} /> : <IconMoon size={13} color={T.ink} />}
      {mode === "dark" ? "Light" : "Dark"}
    </button>
  );
}

// A brand-new user has no project yet -- create one on first login so
// there's always something to show an API key for. The UI doesn't expose
// creating a SECOND project yet (v1 scope: one project per account), but
// the backend/schema already support it.
async function resolveProject(token) {
  const headers = { Authorization: `Bearer ${token}` };
  const listRes = await fetch(`${API_BASE}/projects`, { headers });
  const projects = await listRes.json();
  if (Array.isArray(projects) && projects.length > 0) {
    return { project: projects[0] };
  }
  const createRes = await fetch(`${API_BASE}/projects`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "default" }),
  });
  const created = await createRes.json();
  return { project: created, apiKey: created.api_key };
}

function authRouteFromPath(path) {
  if (path.startsWith("/signup")) return "signup";
  if (path.startsWith("/login")) return "login";
  return "home";
}

function Centered({ children }) {
  return (
    <div style={{ height: "100vh", width: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: T.page, color: T.inkMuted, fontFamily: T.font }}>
      {children}
    </div>
  );
}

const TABS = [
  { id: "connect", label: "Connect" },
  { id: "feed", label: "Feed" },
  { id: "graph", label: "Graph" },
  { id: "policy", label: "Policy" },
];

// Segmented tab bar with a single highlight that slides to the active tab
// (measured from the real button, so it follows font loading / label width).
function TabNav({ view, onChange }) {
  const refs = useRef({});
  const [box, setBox] = useState(null);

  useLayoutEffect(() => {
    // `live` guards the async fonts.ready callback: without it, the previous
    // tab's effect re-measures after this one and pulls the highlight back.
    let live = true;
    const measure = () => {
      const el = refs.current[view];
      if (live && el) setBox({ left: el.offsetLeft, width: el.offsetWidth });
    };
    measure();
    document.fonts?.ready.then(measure);
    window.addEventListener("resize", measure);
    return () => {
      live = false;
      window.removeEventListener("resize", measure);
    };
  }, [view]);

  return (
    <nav style={{ position: "relative", display: "flex", gap: 2, padding: 3, borderRadius: T.radius, border: `1px solid ${T.border}`, background: T.page }}>
      {box && (
        <span
          className="ax-tab-indicator"
          aria-hidden
          style={{
            position: "absolute",
            top: 3,
            bottom: 3,
            left: 0,
            width: box.width,
            transform: `translateX(${box.left}px)`,
            borderRadius: T.radiusSm,
            background: T.surface,
            boxShadow: `inset 0 0 0 1px ${T.border}, ${T.shadow}`,
          }}
        />
      )}
      {TABS.map((t) => (
        <TabButton key={t.id} label={t.label} active={view === t.id} onClick={() => onChange(t.id)} buttonRef={(el) => (refs.current[t.id] = el)} />
      ))}
    </nav>
  );
}

function TabButton({ label, active, onClick, buttonRef }) {
  return (
    <button
      ref={buttonRef}
      onClick={onClick}
      style={{
        position: "relative",
        background: "transparent",
        color: active ? T.ink : T.inkMuted,
        border: "none",
        borderRadius: T.radiusSm,
        padding: "5px 14px",
        fontFamily: T.font,
        fontSize: 12.5,
        fontWeight: 600,
        cursor: "pointer",
        transition: "color 160ms ease",
      }}
    >
      {label}
    </button>
  );
}

const signOutStyle = {
  background: "transparent",
  border: "none",
  color: T.inkMuted,
  fontFamily: T.font,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  textDecoration: "underline",
  textUnderlineOffset: 3,
};

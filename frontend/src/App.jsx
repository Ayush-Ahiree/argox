import React, { useState, useEffect } from "react";
import Argox from "./Argox";
import EventFeed from "./EventFeed";
import PolicyEditor from "./PolicyEditor.jsx";
import ConnectPanel from "./ConnectPanel.jsx";
import LoginPage from "./LoginPage.jsx";
import Home from "./Home.jsx";
import { T, ArgoxLogo } from "./theme.jsx";
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
    <div style={{ height: "100vh", width: "100%", overflow: "hidden", display: "flex", flexDirection: "column", background: T.page, fontFamily: T.font }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "10px 16px", background: T.surface, borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <ArgoxLogo />
        </div>
        <div style={{ display: "flex", gap: 4, background: T.surfaceRaised, borderRadius: 999, padding: 3 }}>
          <TabButton label="Connect" active={view === "connect"} onClick={() => setView("connect")} />
          <TabButton label="Feed" active={view === "feed"} onClick={() => setView("feed")} />
          <TabButton label="Graph" active={view === "graph"} onClick={() => setView("graph")} />
          <TabButton label="Policy" active={view === "policy"} onClick={() => setView("policy")} />
        </div>
        {HOSTED && (
          <button onClick={() => supabase.auth.signOut()} style={signOutStyle}>
            Sign out
          </button>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {view === "connect" && <ConnectPanel project={project} apiKey={freshApiKey} onRegenerateKey={regenerateKey} />}
        {view === "feed" && <EventFeed wsUrl={wsUrl} authSession={session} />}
        {view === "graph" && <Argox wsUrl={wsUrl} />}
        {view === "policy" && <PolicyEditor project={project} session={session} />}
      </div>
    </div>
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

function TabButton({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? T.page : "transparent",
        color: active ? T.ink : T.inkMuted,
        border: "none",
        borderRadius: 999,
        padding: "5px 14px",
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
        transition: "background 120ms ease, color 120ms ease",
      }}
    >
      {label}
    </button>
  );
}

const signOutStyle = {
  marginLeft: "auto",
  background: "transparent",
  border: "none",
  color: T.inkMuted,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  textDecoration: "underline",
};


import React, { useState } from "react";
import { T, ArgoxLogo } from "./theme.jsx";
import { supabase } from "./lib/supabase.js";

/**
 * Email/password auth via Supabase (signup/login/password-reset all
 * handled by Supabase Auth -- see the plan's "full accounts now" call:
 * this is the whole cost of that decision, everything else is Supabase's).
 * Gates the rest of the app in App.jsx; only rendered when hosted config
 * is present (config.js's HOSTED flag).
 */
export default function LoginPage({ initialMode = "login", onBack }) {
  const [mode, setMode] = useState(initialMode); // login | signup | reset
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("idle"); // idle | busy | error | check-email
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setStatus("busy");
    setError(null);
    try {
      if (mode === "login") {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
      } else if (mode === "signup") {
        const { error: err } = await supabase.auth.signUp({ email, password });
        if (err) throw err;
        setStatus("check-email");
        return;
      } else if (mode === "reset") {
        const { error: err } = await supabase.auth.resetPasswordForEmail(email);
        if (err) throw err;
        setStatus("check-email");
        return;
      }
      setStatus("idle");
    } catch (err) {
      setError(err.message || String(err));
      setStatus("error");
    }
  };

  return (
    <div style={{ minHeight: "100vh", width: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, background: T.page, fontFamily: T.font }}>
      <div style={{ width: 340, maxWidth: "calc(100% - 32px)", padding: 28, borderRadius: 12, border: `1px solid ${T.border}`, background: T.surface }}>
        <div style={{ marginBottom: 8 }}><ArgoxLogo /></div>
        <div style={{ fontSize: 13, color: T.inkSecondary, marginBottom: 20 }}>
          {mode === "login" && "Sign in to your dashboard"}
          {mode === "signup" && "Create an account"}
          {mode === "reset" && "Reset your password"}
        </div>

        {status === "check-email" ? (
          <div style={{ fontSize: 13, color: T.inkSecondary, lineHeight: 1.5 }}>
            Check <strong>{email}</strong> for a link to {mode === "signup" ? "confirm your account" : "reset your password"}.
          </div>
        ) : (
          <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={inputStyle}
            />
            {mode !== "reset" && (
              <input
                type="password"
                required
                placeholder="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={inputStyle}
              />
            )}
            {error && <div style={{ fontSize: 12, color: T.critical }}>{error}</div>}
            <button type="submit" disabled={status === "busy"} style={submitStyle}>
              {status === "busy" ? "…" : mode === "login" ? "Sign in" : mode === "signup" ? "Sign up" : "Send reset link"}
            </button>
          </form>
        )}

        <div style={{ marginTop: 16, display: "flex", justifyContent: "space-between", fontSize: 12 }}>
          {mode === "login" ? (
            <>
              <LinkButton onClick={() => setMode("signup")}>Create account</LinkButton>
              <LinkButton onClick={() => setMode("reset")}>Forgot password?</LinkButton>
            </>
          ) : (
            <LinkButton onClick={() => setMode("login")}>Back to sign in</LinkButton>
          )}
        </div>
      </div>
      {onBack && <LinkButton onClick={onBack}>← Back to home</LinkButton>}
    </div>
  );
}

function LinkButton({ onClick, children }) {
  return (
    <button type="button" onClick={onClick} style={{ background: "none", border: "none", color: T.inkMuted, textDecoration: "underline", cursor: "pointer", fontSize: 12, padding: 0 }}>
      {children}
    </button>
  );
}

const inputStyle = {
  padding: "9px 12px",
  borderRadius: 8,
  border: `1px solid ${T.borderStrong}`,
  background: T.page,
  color: T.ink,
  fontSize: 13,
  outline: "none",
};

const submitStyle = {
  padding: "9px 12px",
  borderRadius: 8,
  border: "none",
  background: T.accent,
  color: T.onAccent,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

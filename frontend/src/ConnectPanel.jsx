import React, { useEffect, useState, useCallback } from "react";
import { T, IconCheck, IconX, IconTerminal } from "./theme.jsx";
import { API_BASE, HOSTED } from "./lib/config.js";

const HOOK_SERVER_BASE = API_BASE;
const RELAY_HEALTH_URL = HOSTED ? `${API_BASE}/confirm-status?id=__healthcheck__` : "http://localhost:8766/confirm-status?id=__healthcheck__";

const START_COMMANDS = [
  { cmd: "cd agent && pip install -r requirements.txt", hint: "one-time setup" },
  { cmd: "python cli.py start", hint: "brings up the relay + hook server" },
];

const SETTINGS_SNIPPET = JSON.stringify(
  {
    hooks: {
      PreToolUse: [
        {
          matcher: "Read|Edit|Write|NotebookEdit|Bash|WebFetch|Grep",
          hooks: [{ type: "http", url: "http://localhost:8090/hooks/pre-tool-use", timeout: 120 }],
        },
      ],
      PostToolUse: [
        {
          matcher: "Read|WebFetch|Bash|Grep|mcp__.*",
          hooks: [{ type: "http", url: "http://localhost:8090/hooks/post-tool-use", timeout: 10 }],
        },
      ],
    },
  },
  null,
  2
);

/**
 * Setup wizard + live service-health check.
 *
 * Hosted mode (HOSTED, see lib/config.js): the customer never touches a
 * local backend at all -- `npx argox` writes the hook config straight
 * into their project's .claude/settings.local.json (gitignored, carries
 * the real API key). This tab's job is just showing that project's key
 * once and the two-line command to paste.
 *
 * Local self-host mode (no Supabase config): unchanged from before --
 * the curl|bash flow against a locally-running hook_server.py, since
 * there's no dashboard-issued key to hand out in that mode.
 */
export default function ConnectPanel({ project = null, apiKey = null, onRegenerateKey = null }) {
  // Two entirely separate components (not a shared one with an early
  // return) so each can call hooks unconditionally -- HOSTED is a stable
  // module-level constant, but mixing hooks before/after a conditional
  // return in ONE component is still a Rules-of-Hooks violation.
  return HOSTED ? (
    <HostedConnect project={project} apiKey={apiKey} onRegenerateKey={onRegenerateKey} />
  ) : (
    <LocalConnect />
  );
}

function LocalConnect() {
  const hookStatus = useHealthCheck(() => fetch(`${HOOK_SERVER_BASE}/policies`, { cache: "no-store" }));
  const relayStatus = useHealthCheck(() => fetch(RELAY_HEALTH_URL, { cache: "no-store" }));
  const bothUp = hookStatus === "up" && relayStatus === "up";
  const [showManual, setShowManual] = useState(false);
  const [projectPath, setProjectPath] = useState("");
  // Empty input -> the script falls back to $(pwd), i.e. "wherever you
  // paste this" -- still a single command, just without a path typed in.
  const pathArg = projectPath.trim() || "$(pwd)";
  const connectCommand = `curl -s ${HOOK_SERVER_BASE}/connect.sh | bash -s -- ${pathArg === "$(pwd)" ? pathArg : JSON.stringify(pathArg)}`;

  return (
    <div style={{ height: "100%", width: "100%", background: T.page, color: T.ink, overflow: "auto", fontFamily: T.font }}>
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "32px 20px" }}>
        <div style={{ fontSize: 20, fontWeight: 500, fontFamily: T.fontSerif, marginBottom: 6 }}>Connect an agent</div>
        <div style={{ fontSize: 13, color: T.inkSecondary, marginBottom: 24, lineHeight: 1.5 }}>
          One command, run inside your project — then restart your agent session.
        </div>

        <div style={cardStyle}>
          <SectionHeading>Backend status</SectionHeading>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
            <StatusRow label="Relay (panel feed)" status={relayStatus} detail="ws://localhost:8765" />
            <StatusRow label="Hook server (Claude Code)" status={hookStatus} detail="http://localhost:8090" />
          </div>
          {!bothUp && (
            <div style={{ fontSize: 12.5, color: T.inkMuted, marginTop: 12, lineHeight: 1.5 }}>
              Not both up yet — the command below needs the backend running first.
            </div>
          )}
          {bothUp && (
            <div style={{ fontSize: 12.5, color: T.accent, marginTop: 12, lineHeight: 1.5, fontWeight: 500 }}>
              Backend is up — an agent wired to it will show up on the Feed tab as soon as it makes a tool call.
            </div>
          )}
        </div>

        <div style={{ ...cardStyle, opacity: bothUp ? 1 : 0.45, pointerEvents: bothUp ? "auto" : "none" }}>
          <SectionHeading>Connect your project</SectionHeading>
          <div style={{ fontSize: 13, color: T.inkSecondary, lineHeight: 1.5, marginTop: 10, marginBottom: 12 }}>
            Paste this into a terminal, from (or pointing at) the project you want observed:
          </div>
          <input
            value={projectPath}
            onChange={(e) => setProjectPath(e.target.value)}
            placeholder="/path/to/your/project (leave blank to use the terminal's current directory)"
            style={pathInputStyle}
          />
          <div style={{ marginTop: 10 }}>
            <CommandRow cmd={connectCommand} />
          </div>
          <div style={{ fontSize: 12.5, color: T.inkMuted, marginTop: 12, lineHeight: 1.5 }}>
            Fetches the connect step fresh from this running backend and merges the hooks into that project's{" "}
            <code style={codeInline}>.claude/settings.json</code> — doesn't touch anything already there, and
            no-ops if you run it again. Restart your agent session afterward (hooks load at session start).
          </div>
        </div>

        <button onClick={() => setShowManual((v) => !v)} style={linkButtonStyle}>
          {showManual ? "Hide" : "Show"} backend setup / manual config
        </button>

        {showManual && (
          <>
            <div style={cardStyle}>
              <SectionHeading>Starting the backend (one-time)</SectionHeading>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
                {START_COMMANDS.map(({ cmd, hint }) => (
                  <CommandRow key={cmd} cmd={cmd} hint={hint} />
                ))}
              </div>
            </div>

            <div style={cardStyle}>
              <SectionHeading>Manual setup (no script)</SectionHeading>
              <div style={{ fontSize: 13, color: T.inkSecondary, lineHeight: 1.5, marginTop: 10, marginBottom: 10 }}>
                If you'd rather edit the file yourself, paste this into your project's{" "}
                <code style={codeInline}>.claude/settings.json</code>:
              </div>
              <CodeBlock text={SETTINGS_SNIPPET} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function HostedConnect({ project, apiKey, onRegenerateKey }) {
  const [regenerating, setRegenerating] = useState(false);
  const loginCmd = apiKey ? `npx @amisecured/argox login --key ${apiKey} --api-base ${API_BASE}` : null;
  const connectCmd = "npx @amisecured/argox connect";

  const regenerate = async () => {
    setRegenerating(true);
    try {
      await onRegenerateKey?.();
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div style={{ height: "100%", width: "100%", background: T.page, color: T.ink, overflow: "auto", fontFamily: T.font }}>
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "32px 20px" }}>
        <div style={{ fontSize: 20, fontWeight: 500, fontFamily: T.fontSerif, marginBottom: 6 }}>Connect an agent</div>
        <div style={{ fontSize: 13, color: T.inkSecondary, marginBottom: 24, lineHeight: 1.5 }}>
          Two commands, run inside your project — no local backend to start, this dashboard IS the backend.
        </div>

        <div style={cardStyle}>
          <SectionHeading>Project</SectionHeading>
          <div style={{ fontSize: 13, color: T.inkSecondary, marginTop: 10 }}>
            {project ? project.name : "…"}
          </div>
        </div>

        {apiKey ? (
          <div style={cardStyle}>
            <SectionHeading>Setup</SectionHeading>
            <div style={{ fontSize: 12.5, color: T.critical, marginTop: 10, marginBottom: 10, fontWeight: 600 }}>
              Copy this now — your API key is only ever shown once.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <CommandRow cmd={loginCmd} hint="one-time, stores the key on this machine" />
              <CommandRow cmd={connectCmd} hint="run inside each project you want observed" />
            </div>
            <div style={{ fontSize: 12.5, color: T.inkMuted, marginTop: 12, lineHeight: 1.5 }}>
              Writes hooks + the key into that project's <code style={codeInline}>.claude/settings.local.json</code>{" "}
              (gitignored automatically — the key never ends up in your repo). Restart your agent session afterward.
            </div>
          </div>
        ) : (
          <div style={cardStyle}>
            <SectionHeading>Setup</SectionHeading>
            <div style={{ fontSize: 13, color: T.inkSecondary, marginTop: 10, marginBottom: 12, lineHeight: 1.5 }}>
              Your API key was only shown once, right after this project was created. If you didn't save it, issue a
              fresh one — the old one stops working immediately.
            </div>
            <button onClick={regenerate} disabled={regenerating} style={submitStyle}>
              {regenerating ? "…" : "Regenerate API key"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function useHealthCheck(probe) {
  const [status, setStatus] = useState("checking"); // checking | up | down

  const check = useCallback(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    probe()
      .then(() => setStatus("up"))
      .catch(() => setStatus("down"))
      .finally(() => clearTimeout(timer));
  }, [probe]);

  useEffect(() => {
    check();
    const interval = setInterval(check, 4000);
    return () => clearInterval(interval);
  }, [check]);

  return status;
}

function StatusRow({ label, status, detail }) {
  const up = status === "up";
  const checking = status === "checking";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 14px",
        borderRadius: 6,
        background: T.surface,
        border: `1px solid ${T.border}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {checking ? (
          <div style={{ width: 14, height: 14, borderRadius: "50%", background: T.borderStrong }} />
        ) : up ? (
          <IconCheck size={14} color={T.good} />
        ) : (
          <IconX size={14} color={T.critical} />
        )}
        <span style={{ fontSize: 13 }}>{label}</span>
      </div>
      <span style={{ fontSize: 12, fontFamily: T.fontMono, color: T.inkMuted }}>
        {checking ? "checking…" : up ? `up · ${detail}` : `not detected · ${detail}`}
      </span>
    </div>
  );
}

function CommandRow({ cmd, hint }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "9px 12px",
        borderRadius: 6,
        background: TERM_BG,
        border: `1px solid ${T.border}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <IconTerminal size={13} color={TERM_FG} />
        <code style={{ fontSize: 12.5, fontFamily: T.fontMono, color: TERM_FG, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {cmd}
        </code>
      </div>
      <button onClick={copy} style={copyButtonStyle}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function CodeBlock({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div style={{ position: "relative" }}>
      <pre
        style={{
          margin: 0,
          padding: "14px 16px",
          borderRadius: 6,
          background: TERM_BG,
          color: TERM_FG,
          fontSize: 12,
          fontFamily: T.fontMono,
          lineHeight: 1.5,
          overflowX: "auto",
        }}
      >
        {text}
      </pre>
      <button onClick={copy} style={{ ...copyButtonStyle, position: "absolute", top: 10, right: 10 }}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

const cardStyle = {
  border: `1px solid ${T.border}`,
  borderRadius: 6,
  padding: "18px 18px 20px",
  marginBottom: 20,
};

const codeInline = {
  fontFamily: T.fontMono,
  fontSize: 12,
  background: T.surfaceRaised,
  padding: "1px 5px",
  borderRadius: 4,
};

// Terminal-style blocks stay dark in both themes (inverting with T.ink
// would turn them light-grey in dark mode).
const TERM_BG = "#141412";
const TERM_FG = "#ededeb";

const copyButtonStyle = {
  flexShrink: 0,
  padding: "4px 10px",
  borderRadius: 6,
  border: `1px solid rgba(255,255,255,0.25)`,
  background: "transparent",
  color: TERM_FG,
  fontSize: 11.5,
  fontWeight: 600,
  cursor: "pointer",
};

const submitStyle = {
  padding: "9px 14px",
  borderRadius: 6,
  border: "none",
  background: T.accent,
  color: T.onAccent,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const pathInputStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "9px 12px",
  borderRadius: 6,
  border: `1px solid ${T.borderStrong}`,
  background: T.surface,
  color: T.ink,
  fontSize: 12.5,
  fontFamily: T.fontMono,
  outline: "none",
};

const linkButtonStyle = {
  display: "block",
  background: "transparent",
  border: "none",
  color: T.inkMuted,
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
  padding: "4px 0 20px",
  textDecoration: "underline",
};

function SectionHeading({ children }) {
  return (
    <div style={{ fontSize: 13, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: T.inkMuted }}>
      {children}
    </div>
  );
}

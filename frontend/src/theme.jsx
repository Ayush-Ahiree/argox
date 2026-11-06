import React from "react";

/**
 * Shared design tokens + icons + human-readable label maps, used by every
 * dashboard tab so they read as one system instead of drifting apart.
 *
 * Neutral tokens are CSS variables (see theme.css) so the light/dark
 * toggle flips the whole app without re-rendering. Status hues are fixed
 * hex values that read on both surfaces; each also has an `ink` variant
 * (darker on light, lighter on dark) for text inside status pills.
 *
 * Need a translucent version of any token? Use tint(color, pct) -- it
 * works for both hex values and CSS variables (string-concatenating a
 * hex alpha suffix onto a var() does not).
 */

// Static light palette, for surfaces that never follow the dashboard
// theme toggle (the public marketing homepage).
export const LIGHT = {
  page: "#faf9f7",
  surface: "#ffffff",
  surfaceRaised: "#f2f0ea",
  border: "#17140e14",
  borderStrong: "#17140e3d",
  ink: "#17140e",
  inkSecondary: "#2e2a22",
  inkMuted: "#8a8578",
  gridline: "#e5e2d9",
  onAccent: "#ffffff",
  accent: "#025841",
  accentSoft: "#e6f2ed",
  cool: "#a9d6e5",
  coolInk: "#2f6f82",
  coolSoft: "#e4f1f6",
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
  font: '"Geist", system-ui, -apple-system, "Segoe UI", sans-serif',
  fontMono: '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace',
  fontSerif: '"Newsreader", Georgia, serif',
};

export const T = {
  page: "var(--ax-page)",
  surface: "var(--ax-surface)",
  surfaceRaised: "var(--ax-raised)",
  sunken: "var(--ax-sunken)",
  code: "var(--ax-code)",
  border: "var(--ax-border)",
  borderStrong: "var(--ax-border-strong)",
  ink: "var(--ax-ink)",
  inkSecondary: "var(--ax-ink-2)",
  inkMuted: "var(--ax-muted)",
  gridline: "var(--ax-gridline)",
  onAccent: "#ffffff",
  accent: "var(--ax-accent)",
  accentSoft: "var(--ax-accent-soft)",
  cool: "#a9d6e5",
  coolInk: "#2f6f82",
  coolSoft: "#e4f1f6",
  cardFront: "var(--ax-card-front)",
  cardSide: "var(--ax-card-side)",
  vignette: "var(--ax-vignette)",
  shadow: "var(--ax-shadow)",
  warningSurface: "var(--ax-warning-surface)",
  good: "#22a447",
  warning: "#f0a818",
  serious: "#8b5cf6",
  flagged: "#8b5cf6",
  approved: "#3b82f6",
  critical: "#d93b3b",
  goodInk: "var(--ax-good-ink)",
  warningInk: "var(--ax-warning-ink)",
  criticalInk: "var(--ax-critical-ink)",
  flaggedInk: "var(--ax-flagged-ink)",
  approvedInk: "var(--ax-approved-ink)",
  radius: 6,
  radiusSm: 4,
  font: '"Geist", system-ui, -apple-system, "Segoe UI", sans-serif',
  fontMono: '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace',
  fontSerif: '"Newsreader", Georgia, serif',
};

export function tint(color, pct) {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

export const STATUS = {
  clean: { color: T.good, ink: T.goodInk, label: "Allowed", Icon: IconCheck },
  flagged: { color: T.flagged, ink: T.flaggedInk, label: "Flagged", Icon: IconFlag },
  warning: { color: T.warning, ink: T.warningInk, label: "Approval requested", Icon: IconAlert },
  critical: { color: T.critical, ink: T.criticalInk, label: "Blocked", Icon: IconX },
  approved: { color: T.approved, ink: T.approvedInk, label: "Approved by you", Icon: IconCheck },
  denied: { color: T.critical, ink: T.criticalInk, label: "Denied by you", Icon: IconX },
};

// Persisted light/dark preference for the signed-in dashboard.
const THEME_KEY = "argox_theme_v1";

export function initialTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // storage unavailable
  }
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    // storage unavailable -- preference just won't persist
  }
}

export const TOOL_META = {
  read_file: { label: "Read file", Icon: IconFile },
  write_file: { label: "Wrote file", Icon: IconFile },
  run_shell: { label: "Ran command", Icon: IconTerminal },
  call_api: { label: "Made network request", Icon: IconGlobe },
};

export const SOURCE_META = {
  claude_code: { label: "Claude Code", Icon: IconClaude },
  toy_agent: { label: "Toy Agent", Icon: IconBot },
  api: { label: "SDK agent", Icon: IconBot },
};

// Unknown sources (future integrations) still need a label instead of
// crashing the badge.
export function sourceMeta(source) {
  return SOURCE_META[source] || { label: source ? String(source).replace(/_/g, " ") : "Agent", Icon: IconBot };
}

export const TAG_LABELS = {
  pii: "Personal Info",
  secret: "Secret",
  internal_only: "Internal Only",
  user_uploaded: "User Uploaded",
  untrusted: "Untrusted input",
  // "public" is intentionally omitted -- showing it teaches the user nothing
};

const REASON_LABELS = {
  dangerous_shell_pattern: "Matches a known dangerous command pattern",
  secret_data_exfil_attempt: "Would send previously-read secret data outside the system",
  pii_crossing_trust_boundary: "Would send personal information outside the system",
  internal_data_crossing_trust_boundary: "Would send internal-only data outside the system",
  external_destination_untainted: "New external destination — allowed, flagged for review",
  cloud_metadata_access: "Tried to read the cloud metadata service, which hands out this machine's cloud credentials",
  secret_literal_in_outbound_call: "A secret is written directly into this outbound call",
  untrusted_content_then_egress: "Outbound call after reading outside content — possible prompt injection, flagged for review",
  secret_session_publish: "Publishing while the session holds secret data — asks first",
};

export function humanReason(reason) {
  if (!reason) return null;
  if (REASON_LABELS[reason]) return REASON_LABELS[reason];
  if (reason.startsWith("path_denylist:shell_reference:")) {
    const frag = reason.split(":").slice(2).join(":");
    return `Command references a protected path (${frag})`;
  }
  if (reason.startsWith("path_denylist:")) {
    return `This path is protected (matches ${reason.slice("path_denylist:".length)})`;
  }
  return reason.replace(/_/g, " ");
}

export function eventSeverity(event) {
  if (event.type === "confirm_resolution") return event.decision === "allow" ? "approved" : "denied";
  if (event.decision === "block") return "critical";
  if (event.decision === "pending_confirm") return "warning";
  if (event.decision === "allow" && (event.risk_score || 0) > 0) return "flagged";
  return "clean";
}

// --- icons: small inline SVGs, 16x16 viewBox, explicit color prop (never
// currentColor-as-text-color) so they work as plain data ---

export function IconChevron({ expanded, size = 14, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 150ms ease", flexShrink: 0 }}>
      <path d="M6 4l4 4-4 4" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconCheck({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <circle cx="8" cy="8" r="6.5" fill="none" stroke={color} strokeWidth="1.5" />
      <path d="M5.2 8.2l2 2 3.6-4" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconX({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <circle cx="8" cy="8" r="6.5" fill="none" stroke={color} strokeWidth="1.5" />
      <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function IconAlert({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <path d="M8 2.2l6.2 10.8H1.8L8 2.2z" fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
      <line x1="8" y1="6.5" x2="8" y2="9.3" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11.4" r="0.7" fill={color} />
    </svg>
  );
}

export function IconFlag({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <path d="M4 2v12" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4 2.6h7.5l-1.8 2.7 1.8 2.7H4" fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function IconFile({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <path d="M4 1.5h5l3 3v10h-8z" fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M9 1.5v3h3" fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

export function IconTerminal({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke={color} strokeWidth="1.3" />
      <path d="M4 6.2l2.4 1.9L4 10" fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="8" y1="10" x2="11.5" y2="10" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function IconGlobe({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <circle cx="8" cy="8" r="6.3" fill="none" stroke={color} strokeWidth="1.3" />
      <ellipse cx="8" cy="8" rx="2.6" ry="6.3" fill="none" stroke={color} strokeWidth="1.3" />
      <line x1="1.8" y1="8" x2="14.2" y2="8" stroke={color} strokeWidth="1.3" />
    </svg>
  );
}

export function IconBot({ size = 14, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <rect x="3" y="5.5" width="10" height="7.5" rx="2" fill="none" stroke={color} strokeWidth="1.3" />
      <line x1="8" y1="5.5" x2="8" y2="3" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="2.2" r="0.9" fill={color} />
      <circle cx="6" cy="9" r="0.9" fill={color} />
      <circle cx="10" cy="9" r="0.9" fill={color} />
    </svg>
  );
}

export function IconClaude({ size = 14, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path
        d="M8 1.5l1.6 4.2 4.4.4-3.4 2.9 1.1 4.3L8 10.9l-3.7 2.4 1.1-4.3-3.4-2.9 4.4-.4z"
        fill="none"
        stroke={color}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconLock({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <rect x="3" y="7" width="10" height="7.5" rx="1.5" fill="none" stroke={color} strokeWidth="1.4" />
      <path d="M5.3 7V5a2.7 2.7 0 015.4 0v2" fill="none" stroke={color} strokeWidth="1.4" />
      <circle cx="8" cy="10.6" r="1" fill={color} />
    </svg>
  );
}

// Horizontal logo (mark + wordmark) from the brand kit. The kit's minimum
// width is 80px, so don't go below height 26. variant="auto" follows the
// dashboard theme; "light" always uses the black lockup (for the public
// homepage, which never goes dark).
export function ArgoxLogo({ height = 26, variant = "auto" }) {
  const img = (src, cls) => <img src={src} alt="Argox" height={height} className={cls} style={{ height, width: "auto" }} />;
  if (variant === "light") return img("/argox-lockup-black.svg", undefined);
  return (
    <span style={{ display: "inline-flex" }}>
      {img("/argox-lockup-black.svg", "ax-logo-light")}
      {img("/argox-lockup-white.svg", "ax-logo-dark")}
    </span>
  );
}

export function IconSun({ size = 14, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="3" fill="none" stroke={color} strokeWidth="1.4" />
      <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function IconMoon({ size = 14, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path d="M13.5 9.6A5.8 5.8 0 016.4 2.5a5.8 5.8 0 107.1 7.1z" fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function IconShield({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <path d="M8 1.6l5.2 2v4.1c0 3.2-2.2 5.6-5.2 6.7-3-1.1-5.2-3.5-5.2-6.7V3.6z" fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

export function IconSearch({ size = 14, color = "currentColor", style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
      <circle cx="7" cy="7" r="4.6" fill="none" stroke={color} strokeWidth="1.4" />
      <path d="M10.4 10.4l3.4 3.4" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function IconDownload({ size = 14, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path d="M8 2.5v7.5M4.8 7l3.2 3.2L11.2 7M3 13h10" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconTrash({ size = 14, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path d="M2.8 4.2h10.4M6.3 4.2V2.6h3.4v1.6M4.2 4.2l.7 9.2h6.2l.7-9.2" fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

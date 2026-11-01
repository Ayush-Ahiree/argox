import React from "react";

/**
 * Shared design tokens + icons + human-readable label maps, used by both
 * EventFeed.jsx and Argox.jsx so the two tabs read as one system
 * instead of drifting apart.
 *
 * Palette + type follows thebillow.ai: a warm "paper" surface (not a
 * dark hacker-dashboard theme), Geist for UI/body text, Newsreader (a
 * serif) reserved for headline/editorial moments -- section titles,
 * the wordmark, session headlines -- the same way Billow uses it, not
 * sprinkled everywhere data/numbers need to stay legible.
 *
 * Status palette (good/warning/serious/critical) validated via the
 * dataviz skill's six-checks validator -- the same four hex values are
 * documented to work on BOTH light and dark surfaces (icon+label
 * pairing is the mitigation for the two that sit under 3:1 contrast on
 * a light surface), so these didn't change when the chrome went light.
 */

export const T = {
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

export const STATUS = {
  clean: { color: T.good, label: "Allowed", Icon: IconCheck },
  flagged: { color: T.serious, label: "Flagged", Icon: IconFlag },
  warning: { color: T.warning, label: "Needs Approval", Icon: IconAlert },
  critical: { color: T.critical, label: "Blocked", Icon: IconX },
};

export const TOOL_META = {
  read_file: { label: "Read file", Icon: IconFile },
  write_file: { label: "Wrote file", Icon: IconFile },
  run_shell: { label: "Ran command", Icon: IconTerminal },
  call_api: { label: "Made network request", Icon: IconGlobe },
};

export const SOURCE_META = {
  claude_code: { label: "Claude Code", Icon: IconClaude },
  toy_agent: { label: "Toy Agent", Icon: IconBot },
};

export const TAG_LABELS = {
  pii: "Personal Info",
  secret: "Secret",
  internal_only: "Internal Only",
  user_uploaded: "User Uploaded",
  // "public" is intentionally omitted -- showing it teaches the user nothing
};

const REASON_LABELS = {
  dangerous_shell_pattern: "Matches a known dangerous command pattern",
  secret_data_exfil_attempt: "Would send previously-read secret data outside the system",
  pii_crossing_trust_boundary: "Would send personal information outside the system",
  internal_data_crossing_trust_boundary: "Would send internal-only data outside the system",
  external_destination_untainted: "New external destination — allowed, flagged for review",
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

// Horizontal logo (mark + wordmark) from the brand kit, for light surfaces.
// The kit's minimum width is 80px, so don't go below height 26.
export function ArgoxLogo({ height = 26 }) {
  return <img src="/argox-lockup-black.svg" alt="Argox" height={height} style={{ display: "block", height, width: "auto" }} />;
}

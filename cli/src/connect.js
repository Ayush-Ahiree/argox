"use strict";

// Ports the merge logic from agent/cli.py's cmd_connect (Python), but
// targets .claude/settings.local.json instead of settings.json --
// Claude Code gitignores settings.local.json automatically, so the API
// key this writes never ends up in git. Non-destructive: preserves
// whatever's already in the file, no-ops if already wired.

const fs = require("fs");
const path = require("path");

const HOOK_CONFIG = {
  PreToolUse: { matcher: "Read|Edit|Write|NotebookEdit|Bash|WebFetch|Grep|mcp__.*", timeout: 120 },
  PostToolUse: { matcher: "Read|WebFetch|WebSearch|Bash|Grep|mcp__.*", timeout: 10 },
};

// Secret shapes to look for in Claude Code's settings files. When you
// approve a command with "don't ask again", Claude Code saves it verbatim
// as an allow rule -- keys typed into that command end up in
// .claude/settings.local.json, and from there in git (Nov 2026: thousands
// of keys found on GitHub this way).
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/, /AKIA[0-9A-Z]{16}/, /ASIA[0-9A-Z]{16}/, /AIza[0-9A-Za-z_-]{35}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /gsk_[A-Za-z0-9]{20,}/, /xox[abpr]-[A-Za-z0-9-]{10,}/,
  /sk_live_[A-Za-z0-9]{16,}/, /glpat-[A-Za-z0-9_-]{20,}/, /npm_[A-Za-z0-9]{30,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:\/@'"]+:[^\s@\/'"$<{]{3,}@/,
  /\b[A-Z0-9_]*(?:PASSWORD|SECRET|API_KEY|TOKEN|ACCESS_KEY)=(?!\$)[^\s'"]{6,}/,
];

function mask(value) {
  return value.length <= 8 ? "****" : `${value.slice(0, 4)}…${value.slice(-2)}`;
}

// Scan a file for secrets; returns [{line, preview}]. Argox's own
// ARGOX_API_KEY entry (written by connect, in the gitignored local file)
// is skipped.
function scanFile(file) {
  if (!fs.existsSync(file)) return [];
  const hits = [];
  fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (line.includes("ARGOX_API_KEY")) return;
    for (const re of SECRET_PATTERNS) {
      const m = line.match(re);
      if (m) {
        hits.push({ line: i + 1, preview: mask(m[0]) });
        break;
      }
    }
  });
  return hits;
}

// Is `rel` (relative to projectDir) ignored by the project's .gitignore?
// Uses git itself when available so every ignore rule is honoured.
function gitIgnored(projectDir, rel) {
  try {
    require("child_process").execFileSync("git", ["check-ignore", "-q", rel], { cwd: projectDir, stdio: "ignore" });
    return true;
  } catch (e) {
    return e.status === 1 ? false : null; // 1 = not ignored; anything else = not a repo / no git
  }
}

function gitTracked(projectDir, rel) {
  try {
    require("child_process").execFileSync("git", ["ls-files", "--error-unmatch", rel], { cwd: projectDir, stdio: "ignore" });
    return true;
  } catch (e) {
    return false;
  }
}

function gitHistory(projectDir, rel) {
  try {
    const out = require("child_process").execFileSync(
      "git", ["log", "--all", "--format=%h", "--", rel],
      { cwd: projectDir, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }
    );
    return out.split("\n").filter(Boolean);
  } catch (e) {
    return [];
  }
}

function scanSettings(projectDir) {
  const messages = [];
  const files = [
    ".claude/settings.local.json", ".claude/settings.json", ".mcp.json", "CLAUDE.md",
    ".claude/settings.local.json.bak", ".claude/settings.json.bak",
  ];
  let found = false;
  for (const rel of files) {
    const hits = scanFile(path.join(projectDir, rel));
    if (!hits.length) continue;
    found = true;
    const tracked = gitTracked(projectDir, rel);
    messages.push(`[warn]  ${rel}: ${hits.length} possible secret(s)${tracked ? " -- AND THIS FILE IS COMMITTED TO GIT" : ""}`);
    for (const h of hits.slice(0, 5)) messages.push(`          line ${h.line}: ${h.preview}`);
  }
  // deleting the file doesn't remove it from git history (or forks)
  const history = gitHistory(projectDir, ".claude/settings.local.json");
  if (history.length) {
    found = true;
    messages.push(
      `[warn]  .claude/settings.local.json is in git history (${history.length} commit(s), latest ${history[0]}).`,
      "        Anything it ever held should be treated as leaked if the repo was ever pushed."
    );
  }
  if (found) {
    messages.push(
      "        Remove these values (use environment variables instead), rotate any key that was ever",
      "        committed or pushed, and check git history: git log -p -- .claude/"
    );
  }
  return messages;
}

// Make sure the file holding the Argox key (and Claude Code's saved allow
// rules) can't be committed by accident.
function ensureGitignored(projectDir) {
  const rels = [".claude/settings.local.json", ".claude/*.bak"];
  const missing = rels.filter((rel) => gitIgnored(projectDir, rel.replace("*", "settings.local.json")) === false);
  if (!missing.length) return [];
  const gi = path.join(projectDir, ".gitignore");
  const current = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
  const block = `${current && !current.endsWith("\n") ? "\n" : ""}\n# Claude Code local settings (saved allow rules can contain secrets) -- added by argox\n${missing.join("\n")}\n`;
  fs.appendFileSync(gi, block);
  return [`[add]   ${missing.join(", ")} -> .gitignore`];
}

function loadSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  const content = fs.readFileSync(settingsPath, "utf8").trim();
  if (!content) return {};
  return JSON.parse(content);
}

function hookAlreadyWired(existingBlocks, url) {
  return existingBlocks.some((block) =>
    (block.hooks || []).some((hook) => hook.url === url)
  );
}

function connect(projectDir, { apiBase, apiKey, failClosed = false }) {
  const claudeDir = path.join(projectDir, ".claude");
  const settingsPath = path.join(claudeDir, "settings.local.json");

  if (!fs.existsSync(projectDir)) {
    throw new Error(`${projectDir} does not exist`);
  }

  let settings;
  try {
    settings = loadSettings(settingsPath);
  } catch (e) {
    throw new Error(`${settingsPath} is not valid JSON (${e.message}) -- fix or remove it, then re-run`);
  }

  settings.hooks = settings.hooks || {};
  settings.env = settings.env || {};

  const messages = [...scanSettings(projectDir)];
  let changed = false;

  for (const [event, cfg] of Object.entries(HOOK_CONFIG)) {
    const url = `${apiBase}/hooks/${event === "PreToolUse" ? "pre" : "post"}-tool-use`;
    const existing = settings.hooks[event] || (settings.hooks[event] = []);
    if (hookAlreadyWired(existing, url)) {
      // an older connect wrote a narrower matcher (it used to miss
      // Bash/Grep/MCP output) -- bring it up to date in place
      const stale = existing.filter((b) => (b.hooks || []).some((h) => h.url === url) && b.matcher !== cfg.matcher);
      let touched = false;
      for (const block of stale) {
        block.matcher = cfg.matcher;
        messages.push(`[update] ${event} matcher -> ${cfg.matcher}`);
        touched = true;
      }
      if (event === "PreToolUse" && failClosed) {
        for (const block of existing) {
          for (const hook of block.hooks || []) {
            if (hook.url === url && hook.onFailure !== "block") {
              hook.onFailure = "block";
              messages.push("[update] PreToolUse -> fail closed (onFailure: block)");
              touched = true;
            }
          }
        }
      }
      if (touched) changed = true;
      else messages.push(`[skip]  ${event} already wired to ${url}`);
      continue;
    }
    existing.push({
      matcher: cfg.matcher,
      hooks: [
        {
          type: "http",
          url,
          timeout: cfg.timeout,
          headers: { Authorization: "Bearer $ARGOX_API_KEY" },
          allowedEnvVars: ["ARGOX_API_KEY"],
          // fail closed: if Argox can't be reached or times out, the tool
          // call is blocked instead of running unchecked (Claude Code
          // v2.1.295+). Opt-in: an outage then stops the agent working.
          ...(event === "PreToolUse" && failClosed ? { onFailure: "block" } : {}),
        },
      ],
    });
    messages.push(`[add]   ${event} -> ${url}`);
    changed = true;
  }

  if (settings.env.ARGOX_API_KEY !== apiKey) {
    settings.env.ARGOX_API_KEY = apiKey;
    changed = true;
  }

  try {
    messages.push(...ensureGitignored(projectDir));
  } catch (e) {
    messages.push(`[warn]  could not update .gitignore (${e.message}) -- make sure .claude/settings.local.json is ignored`);
  }

  if (!changed) {
    return { changed: false, settingsPath, messages: [...messages, `${projectDir} is already wired up. Nothing to do.`] };
  }

  fs.mkdirSync(claudeDir, { recursive: true });
  if (fs.existsSync(settingsPath)) {
    fs.copyFileSync(settingsPath, `${settingsPath}.bak`);
    messages.push(`[backup] previous settings saved to ${settingsPath}.bak`);
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  messages.push(`\nWired up: ${settingsPath}`);
  messages.push(
    "Claude Code reads hook config at session start -- start a new session in that project (or restart the current one) for this to take effect."
  );

  return { changed: true, settingsPath, messages };
}

module.exports = { connect, scanSettings };

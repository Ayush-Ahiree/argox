"use strict";

// Ports the merge logic from agent/cli.py's cmd_connect (Python), but
// targets .claude/settings.local.json instead of settings.json --
// Claude Code gitignores settings.local.json automatically, so the API
// key this writes never ends up in git. Non-destructive: preserves
// whatever's already in the file, no-ops if already wired.

const fs = require("fs");
const path = require("path");

const HOOK_CONFIG = {
  PreToolUse: { matcher: "Read|Edit|Write|NotebookEdit|Bash|WebFetch|Grep", timeout: 120 },
  PostToolUse: { matcher: "Read|WebFetch|WebSearch|Bash|Grep|mcp__.*", timeout: 10 },
};

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

function connect(projectDir, { apiBase, apiKey }) {
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

  const messages = [];
  let changed = false;

  for (const [event, cfg] of Object.entries(HOOK_CONFIG)) {
    const url = `${apiBase}/hooks/${event === "PreToolUse" ? "pre" : "post"}-tool-use`;
    const existing = settings.hooks[event] || (settings.hooks[event] = []);
    if (hookAlreadyWired(existing, url)) {
      // an older connect wrote a narrower matcher (it used to miss
      // Bash/Grep/MCP output) -- bring it up to date in place
      const stale = existing.filter((b) => (b.hooks || []).some((h) => h.url === url) && b.matcher !== cfg.matcher);
      for (const block of stale) {
        block.matcher = cfg.matcher;
        messages.push(`[update] ${event} matcher -> ${cfg.matcher}`);
        changed = true;
      }
      if (!stale.length) messages.push(`[skip]  ${event} already wired to ${url}`);
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

module.exports = { connect };

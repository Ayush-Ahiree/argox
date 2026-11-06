---
title: "Keeping secrets away from Claude Code: what each control actually covers"
description: "Deny rules, the sandbox, hooks and egress checks for Claude Code, tested against how real leaks happened. What each layer stops, what slips past it, and a config to start from."
pubDate: 2026-11-06
tags: ["Claude Code", "Secrets", "Guides"]
keyword: "claude code security env file"
hue: 150
glyph: "⌘"
---

Most advice on keeping Claude Code away from your secrets fits in one line: add `.env` to a deny list. That's a good first step and nowhere near the whole job. In the one well-documented case where Claude Code leaked a key, [CVE-2025-55284](https://embracethered.com/blog/posts/2025/claude-code-exfiltration-via-dns-requests), the agent never asked to read `.env`. It ran `strings .e*`, piped the result through `grep`, and sent the key out inside a `ping`.

This guide goes through the controls Claude Code gives you today, plus one it doesn't. For each, it covers what it covers and, more usefully, what it doesn't, based on Anthropic's current documentation and on how real leaks have played out.

<aside class="tldr">
<span class="label">TL;DR</span>

1. `Read` deny rules cover Claude's file tools and common shell readers like `cat`, but not scripts or `grep -r`.
2. The sandbox enforces paths and network at the OS level, but it's off by default, reads most of your home directory unless told otherwise, and doesn't cover MCP servers.
3. Hooks let you inspect every call, but a timed-out hook lets the call through unless you say otherwise.
4. All of the above control *access*. None of them notices a secret that was legitimately read on its way out through an allowed channel. That needs an egress check.
</aside>

## Why `.gitignore` and `.claudeignore` don't count

Two common assumptions to clear first. `.gitignore` tells git what not to track; Claude Code reads ignored files like any other. And according to [Anthropic's permissions docs](https://code.claude.com/docs/en/permissions), a `.claudeignore` file "has no effect". Its entries belong in `Read` deny rules.

## Layer 1: permission deny rules

The built-in permission system lets you deny reads by path. In `.claude/settings.json`, committed so the whole team gets it:

```json
{
  "permissions": {
    "deny": [
      "Read(.env)",
      "Read(.env.*)",
      "Read(**/secrets/**)",
      "Read(~/.aws/**)",
      "Read(~/.ssh/**)"
    ]
  }
}
```

Bare filenames follow gitignore semantics, so `Read(.env)` matches a `.env` at any depth under the project.

This used to cover only Claude's own Read tool. It now goes further. The docs say Read and Edit deny rules apply "to file commands Claude Code recognizes in Bash, such as `cat`, `head`, `tail`, `sed`, and `tee`, and to the targets of Bash redirections such as `> file` and `< file`."

**What still gets through.** The same paragraph spells out the limits. Deny rules don't apply "to a command that reads files without naming them, such as `grep -r pattern .`", or "to arbitrary subprocesses that read or write files indirectly, like a Python or Node script that opens files itself." In practice that means:

```bash
grep -r "AWS_SECRET" .                                  # never names the file
python3 -c "print(open('.env').read())"                 # a script opens it
node -e "console.log(require('fs').readFileSync('.env','utf8'))"
```

The docs are also blunt about trying to plug those holes with Bash patterns: "Bash permission patterns that try to constrain command arguments are fragile." A deny rule on `curl` doesn't match the same program called by its full path or inside `sh -c`.

Deny rules are cheap and worth having. Treat them as a guardrail for the honest mistake, not a boundary against an agent that's been told to find your keys.

## Layer 2: the sandbox

For enforcement that doesn't depend on parsing command text, Claude Code has an OS-level [sandbox](https://code.claude.com/docs/en/sandboxing) (Seatbelt on macOS, bubblewrap on Linux and WSL2). It's **off by default**; turn it on with `/sandbox` or in settings. Two layers matter here.

**Filesystem.** By default, sandboxed commands can read "most of the machine, including credential files such as `~/.ssh` and `~/.aws/credentials`." Lock that down explicitly. The `credentials` setting both denies file reads and unsets environment variables before each sandboxed command:

```json
{
  "sandbox": {
    "enabled": true,
    "allowUnsandboxedCommands": false,
    "credentials": {
      "files": [
        { "path": "~/.aws/credentials", "mode": "deny" },
        { "path": "~/.ssh", "mode": "deny" }
      ],
      "envVars": [
        { "name": "GITHUB_TOKEN", "mode": "deny" },
        { "name": "NPM_TOKEN", "mode": "deny" }
      ]
    },
    "filesystem": {
      "denyRead": ["~/**/.env", "~/**/.env.*"]
    }
  }
}
```

Note `allowUnsandboxedCommands: false`. Without it, when a command fails inside the sandbox, Claude can retry it with `dangerouslyDisableSandbox`, which runs it with your full access after a prompt. One more catch: `denyRead` restricts sandboxed shell commands, not Claude's built-in Read tool, which follows the permission rules from Layer 1. **You need both layers.**

**Network.** Sandboxed commands have no direct route out. Traffic goes through a local proxy that allows only the domains you list. This is the layer that would have stopped the `ping` leak cold, because ICMP and UDP can't leave the sandbox at all.

**What the sandbox doesn't cover.** In Anthropic's words, it "is not a complete isolation boundary":

- It wraps shell commands only. Claude's file tools, **MCP servers** and hooks run outside it.
- Filtering is by hostname without inspecting TLS. The docs warn that "allowing broad domains such as `github.com` can create paths for data exfiltration." That's a real problem, because nearly every coding workflow needs GitHub. In the [Comment and Control](https://oddguan.com/blog/comment-and-control-prompt-injection-credential-theft-claude-code-gemini-cli-github-copilot/) disclosure, GitHub itself was the exfiltration channel for all three agents.
- Native Windows isn't supported; commands run unsandboxed there. Use WSL2.

## Layer 3: hooks

A [`PreToolUse` hook](https://code.claude.com/docs/en/hooks) is your own code that sees every tool call (the tool name and its full input) before it runs, and can block it. Exit with code 2, or return JSON with `"permissionDecision": "deny"`. Hooks can be shell commands or HTTP endpoints, so the logic can live in a service rather than a script in every repo.

Hooks are where you put checks that rules can't express: "this command references a protected file even though it's inside a Python one-liner", or "this is the third outbound call to a new host in a minute."

Two details from the docs that are easy to miss:

- **Timeouts fail open.** "On `PreToolUse`, a timed-out `command`, `http`, or `mcp_tool` hook doesn't block the tool call" unless you set `"onFailure": "block"`. If your hook calls a remote service, decide deliberately whether an outage should stop the agent or wave everything through.
- **Hooks can't loosen rules.** A hook returning `allow` doesn't override a matching deny rule. Deny wins, which is what you want.

## Layer 4: checking what leaves, not just what's read

Everything above controls *access*: which files can be read and which hosts can be reached. That leaves a gap that shows up in almost every real incident. The agent reads a secret it legitimately needs (the deploy config has the cloud key in it), and later sends it out through a channel that's legitimately allowed (GitHub, your own API, a DNS lookup).

Closing that gap means tracking data rather than commands:

1. When the agent reads something, classify it: does it contain a secret, personal data, internal-only material, or text from an untrusted source?
2. Remember that for the rest of the session, even when later commands never mention the file.
3. Before any call that sends data somewhere (`curl`, `git push`, a PR comment, an API request, a DNS lookup), check it against what the session is holding.

That's what [Argox](https://www.getargox.com) does, running as a Claude Code hook. Some decisions it makes, taken directly from its policy engine:

| Session state | Agent tries to | Decision |
| --- | --- | --- |
| Nothing sensitive | `python3 -c "print(open('.env').read())"` | <span class="v block">Blocked</span>: protected path inside a script |
| Nothing sensitive | `node -e "...readFileSync('.env')"` | <span class="v block">Blocked</span>: protected path inside a script |
| Nothing sensitive | `cat /proc/self/environ` | <span class="v block">Blocked</span>: environment dump |
| Read a file containing a key | `ping` / `dig` / `nslookup` an outside host | <span class="v block">Blocked</span>: secret leaving the machine |
| Read a file containing a key | `curl` to any outside host | <span class="v block">Blocked</span>: secret leaving the machine |
| Read a file containing a key | `git push` or `gh pr comment` | <span class="v ask">Asks you</span>: publishing is normal work |
| Read a file containing a key | call your own API (marked trusted) | <span class="v allow">Allowed</span> |
| Read a file containing a key | `npm test`, edit files | <span class="v allow">Allowed</span>: nothing leaves |

It isn't magic either. Data-flow tracking is only as good as its classification: a secret that doesn't look like one won't be tagged. That's why it belongs on top of Layers 1 to 3, not in place of them.

## A starting configuration

If you do nothing else this week:

- [ ] Add `Read` deny rules for `.env*`, secrets directories, `~/.ssh` and `~/.aws` to the project's `.claude/settings.json`, and commit it.
- [ ] Delete any `.claudeignore` and move its entries into deny rules.
- [ ] Turn on the sandbox, set `allowUnsandboxedCommands: false`, and deny `~/.ssh`, `~/.aws` and long-lived tokens through `sandbox.credentials`.
- [ ] Keep the sandbox's allowed-domain list short, and remember that every entry, especially `github.com`, is also an exit.
- [ ] If you run a `PreToolUse` hook against a remote service, decide on `onFailure` explicitly.
- [ ] Add a check on outbound calls that knows what the session has read.
- [ ] Move secrets you don't need locally out of plain files. The [Nx attack](../real-ai-agent-data-leaks/) showed that anything in your home directory is one malicious `postinstall` away from being searched by your own agent.

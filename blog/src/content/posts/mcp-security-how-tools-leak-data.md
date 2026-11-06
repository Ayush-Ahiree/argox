---
title: "MCP security: the four ways your agent's tools can leak data"
description: "Malicious servers, poisoned tool descriptions, injected tool output and vulnerable client plumbing: how each MCP attack works, the real incidents behind them, and what to do."
pubDate: 2026-11-06
tags: ["MCP", "Prompt injection"]
keyword: "MCP security"
hue: 268
glyph: "⧉"
---

The Model Context Protocol made it trivial to give an agent new abilities: install a server and your agent can query a database, file GitHub issues or send email. It also made it trivial to give an agent new ways to leak. Every MCP server you add is code running with your credentials, plus a stream of text your agent will believe.

"MCP security" gets used as one bucket, but the incidents so far fall into four distinct failure modes, and each needs a different fix. Here they are, with the documented cases behind each.

<aside class="tldr">
<span class="label">The four failure modes</span>

1. **The server is malicious.** You installed something that steals.
2. **The tool description is poisoned.** Instructions hidden in metadata the model reads but you don't.
3. **The tool output carries the attack.** A legitimate server returns attacker-written content. This is the most common case and the hardest to fix.
4. **The plumbing is vulnerable.** The client-side glue has an ordinary bug.
</aside>

## 1. The server itself is malicious

In September 2025, Koi Security found what they called the first malicious MCP server in the wild. The npm package [`postmark-mcp`](https://thehackernews.com/2025/09/first-malicious-mcp-server-found.html) presented itself as an integration for the Postmark email service. It wasn't from Postmark. Its code was copied from Postmark's real open-source server, and version 1.0.16 added one line: a BCC to the author's address on every email it sent. The package was getting about 1,500 downloads a week.

Nothing about the agent was compromised. It sent the emails it was asked to send. The server quietly copied them.

**What helps:**

- Install MCP servers from the vendor's own organization, and check the publisher on the registry rather than the package name.
- Pin exact versions and review updates like any dependency that handles secrets. A server that is fine today can ship a malicious update tomorrow.
- Run servers with the narrowest credentials that work: a sending-only API key, a read-only database role.

## 2. The tool description is poisoned

An MCP server tells the client what tools it offers, with names, descriptions and parameter schemas. The model reads all of it. The person approving tool calls usually sees a short name.

[Invariant Labs demonstrated this in April 2025](https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks) with a tool called `add` that, as far as the user could tell, added two numbers. Its description contained a block marked `<IMPORTANT>` telling the model to read `~/.cursor/mcp.json` (where other MCP servers' credentials live) and `~/.ssh/id_rsa`, pass their contents in a parameter called `sidenote`, and not mention any of this to the user. Tested in Cursor, the confirmation dialog didn't show the arguments, so the user approved an "add" and handed over their SSH key.

The same research described two variations:

- **Rug pulls.** A server can change a tool's description *after* you've approved it. Approval at install time says nothing about what the description says next week.
- **Shadowing.** A malicious server's tool description can change how the agent uses *other*, trusted servers. Invariant's example redirected every email sent through a legitimate `send_email` tool to the attacker, without the malicious tool ever being called.

CyberArk researchers later showed that the description isn't the only field that works. Any part of the tool schema the model reads can carry instructions.

**What helps:**

- Read the full tool descriptions and schemas of a server before enabling it, not just its README.
- Pin tool definitions (by hash, if your client or a scanner supports it) and get alerted when they change.
- Be suspicious of any server whose tools ask for broad parameters like "notes" or "context" that could carry anything.
- Use clients that show the full arguments of a tool call in the approval prompt.

## 3. The tool output carries the attack

This is the big one, because the server is legitimate, the tools are honest, and it still leaks.

**GitHub MCP, May 2025.** [Invariant Labs](https://invariantlabs.ai/blog/mcp-github-vulnerability) showed an agent connected to the official GitHub MCP server, with a token covering public and private repos, being asked to look at issues on a public repository. An attacker-filed issue told the agent to collect information from the user's private repositories and publish it. The agent opened a pull request on the public repo containing private repo names, relocation plans and a salary. Invariant stressed that the GitHub server's code had no bug.

**Supabase MCP, July 2025.** [General Analysis](https://www.generalanalysis.com/blog/supabase-mcp-blog) showed a Cursor agent connected with the `service_role` key (which bypasses row-level security) reading support tickets. A ticket asked the agent to read the `integration_tokens` table and post the results back into the ticket. It did. As [Simon Willison noted](https://simonwillison.net/2025/Jul/6/supabase-mcp-lethal-trifecta/), this single server supplied all three parts of the lethal trifecta at once: private data, attacker-written content, and a way to write data where the attacker could read it.

The uncomfortable truth is that a model can't reliably tell "data I fetched" from "instructions I should follow". An issue body, a ticket, a web page, a commit message and a Slack thread are all text, and any of them can be written by someone else.

**What helps:**

- **Treat every MCP response as untrusted input**, even from servers you trust. The server is trusted; the content it returns is not.
- **Scope tokens to the task.** A repo-scoped GitHub token would have made the private repos unreachable. Supabase recommends its read-only, project-scoped mode by default.
- **Split read and write.** An agent that reads customer-written content shouldn't also hold a tool that writes somewhere that customer can see. This is Meta's ["Rule of Two"](https://ai.meta.com/blog/practical-ai-agent-security/) applied to tools: no session should combine untrusted input, sensitive data and the ability to communicate or change state.
- **Watch what leaves.** If a session has read something sensitive, check the next outbound action (a comment, a PR, a message) against it.

Argox takes the first and last of these on directly: output from MCP tools is tagged as untrusted when it enters the session, so later outbound calls are judged with that history in mind.

## 4. The plumbing is vulnerable

Sometimes it's just a bug. `mcp-remote`, a widely used npm package that connects local clients to remote MCP servers, had a critical one: [CVE-2025-6514](https://jfrog.com/blog/2025-6514-critical-mcp-remote-rce-vulnerability/), rated CVSS 9.6 by JFrog, who found it. During the OAuth flow, a malicious server could return a crafted authorization URL that ended up executing commands on the user's machine. The attack was most powerful on Windows. Versions 0.0.5 through 0.1.15 were affected; 0.1.16 fixed it. JFrog called it the first full remote code execution on a client from connecting to an untrusted MCP server.

**What helps:** the ordinary things. Keep MCP tooling updated, connect only to remote servers you trust, and use HTTPS.

## One more thing about sandboxes

If you rely on an agent sandbox for protection, check what it covers. Claude Code's sandbox, for example, [isolates shell commands](https://code.claude.com/docs/en/sandboxing) and their child processes, but its own documentation lists MCP servers among the things that run outside it. An MCP server has whatever network and file access the agent process has. Containment for MCP has to come from the server's credentials, from a container you run it in, or from a check on the calls the agent makes.

## A checklist for every MCP server you add

- [ ] Is the publisher the vendor? Pin the version.
- [ ] Have you read every tool's full description and schema?
- [ ] What's the narrowest credential it can run with? Read-only? Scoped to one project or repo?
- [ ] Does it return content other people can write (issues, tickets, emails, web pages)? Then its output is untrusted.
- [ ] Can it write somewhere outsiders can read (public repos, tickets, outgoing email)? Then it's an exit.
- [ ] If both of the last two are yes, does that server really need to be in the same session as your secrets?

Most leaks so far didn't need clever exploits. They needed an agent that could read something private, read something an attacker wrote, and write somewhere public, all in one session. Remove any one of those, and the incidents above don't happen.

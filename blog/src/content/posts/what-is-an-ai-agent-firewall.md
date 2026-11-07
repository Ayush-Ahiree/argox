---
title: "What is an AI agent firewall? Three kinds, and what a data firewall adds"
description: "An AI agent firewall checks what an agent does, not just what it says. The three kinds on the market, what each one sees, and why tracking data beats filtering commands."
pubDate: 2026-11-07
tags: ["AI agent firewall", "AI agent security", "Guides"]
keyword: "AI agent firewall"
hue: 24
glyph: "⛨"
---

An **AI agent firewall** is a control that sits between an AI agent and the things it can act on (the shell, files, the network, APIs, MCP servers) and decides whether each action is allowed before it happens. A network firewall asks "may this machine talk to this address?" An AI agent firewall asks "may this agent, having done what it has done so far, take this action?"

The term is new and is being used for very different products. Some inspect prompts, some inspect network traffic, some inspect tool calls. They're not interchangeable, and the differences decide which attacks each one can stop. This guide sorts them out, using vendors' own documentation and documented incidents.

<aside class="tldr">
<span class="label">The short version</span>

- **Prompt firewalls** inspect text going into a model. They help with chatbots and see nothing an agent does afterwards.
- **Egress firewalls** restrict which hosts an agent can reach. They stop exfiltration to strange domains, and nothing that goes through a domain you allowed.
- **Action firewalls** inspect each tool call before it runs. The useful ones also remember what data the session has read. That's a **data firewall**, and it's the only kind that catches a secret leaving through an allowed channel.
</aside>

## Why your existing firewall doesn't see the problem

Take a documented case. In the [Comment and Control](https://oddguan.com/blog/comment-and-control-prompt-injection-credential-theft-claude-code-gemini-cli-github-copilot/) disclosure (April 2026), GitHub's Copilot agent was running behind a network firewall. An attacker's text got it to commit a base64-encoded file of tokens into a pull request. To the firewall, that was an HTTPS connection to `github.com`, which it had been told to allow. Nothing was wrong at the network layer. What was wrong was the *content* and the *reason*: the agent was sending secrets it had read because a stranger asked it to.

That's the gap the whole category exists for. Agents act with your credentials, take instructions from text anyone can write, and mostly use destinations you trust. Traditional controls see addresses and ports. They don't see that this particular request carries the API key the agent read four steps earlier.

## Kind 1: prompt firewalls

**What they inspect:** the text sent to a model, and sometimes the text it sends back.

The clearest example is Cloudflare's [Firewall for AI](https://blog.cloudflare.com/take-control-of-public-ai-application-security-with-cloudflare-firewall-for-ai/), in open beta since March 2025. It sits in front of an LLM-powered endpoint and scores each incoming prompt. The [documented fields](https://developers.cloudflare.com/waf/detections/firewall-for-ai/fields/) include a 1–99 prompt-injection score and a flag for personal data in the prompt, detected with the open-source Presidio library. You write firewall rules against those fields, such as blocking prompts with a low injection score or containing card numbers.

**Good for:** public chat products, abuse at the front door, keeping customers' personal data out of a model provider's logs.

**Blind to:** everything the agent does. A prompt firewall sees the user's question. It doesn't see the web page the agent fetched afterwards, the file it read, or the `curl` it ran. In nearly every documented agent leak, the malicious instruction arrived through one of those side doors (an issue, a ticket, a source file), never in the user's prompt.

## Kind 2: egress firewalls

**What they inspect:** network traffic leaving the agent's environment.

[Coder's Agent Firewall](https://coder.com/docs/ai-coder/agent-firewall) is a good reference design. It runs the agent's process in a jail (Linux namespaces, or Landlock on newer kernels) and lets traffic through only to domains on an allowlist, optionally restricted by HTTP method and path. Every request is logged as allowed or denied, with the rule that matched. Claude Code's built-in [sandbox](https://code.claude.com/docs/en/sandboxing) works on similar lines: commands run with no direct network route, behind a proxy that allows only listed domains. Open-source projects such as Pipelock take the proxy approach further and, [per Help Net Security](https://www.helpnetsecurity.com/2026/05/04/pipelock-open-source-ai-agent-firewall/), also inspect MCP and agent-to-agent traffic.

**Good for:** exfiltration to places your agent never needs to go. A properly configured sandbox would have stopped the [DNS leak in Claude Code](https://embracethered.com/blog/posts/2025/claude-code-exfiltration-via-dns-requests) (CVE-2025-55284), where an API key left the machine inside a `ping` hostname, because ICMP and arbitrary DNS can't leave the sandbox.

**Blind to:** the domains you allowed. Claude Code's sandbox docs are direct about this: "allowing broad domains such as `github.com` can create paths for data exfiltration." Every coding agent needs GitHub. In our review of [six real AI agent data leaks](../real-ai-agent-data-leaks/), four used GitHub or the app's own database as the way out. An allowlist answers "may the agent reach this host?", which is rarely the question that matters.

## Kind 3: action firewalls

**What they inspect:** each tool call (its name and full arguments) before it runs.

This is where the agent's intent is visible. The hook points already exist in the major frameworks:

- Claude Code's [`PreToolUse` hooks](https://code.claude.com/docs/en/hooks) receive every tool call and can block it.
- The OpenAI Agents SDK has [tool guardrails](https://openai.github.io/openai-agents-python/guardrails/) that run before and after a function tool executes.
- Agent frameworks generally let you wrap tools in your own checks.

**Good for:** catching dangerous commands in any form the agent tries, including the ones permission rules miss: `python3 -c "open('.env')"`, `cat /proc/self/environ`, a request to the cloud metadata address.

**Blind to, if stateless:** context. A stateless check sees `curl -X POST https://api.example.net -d @report.json` and has to decide on that alone. Is `report.json` a test fixture or the customer export the agent built two minutes ago? It can't know. So it either blocks every outbound call and is switched off within a week, or allows them and misses the leak.

## What a data firewall adds

A **data firewall** is an action firewall that remembers. It follows the data, not just the command:

1. **Classify what comes in.** When the agent reads a file, a database row, an API response or a web page, label what's in it: a secret, personal data, internal-only material, or untrusted text from outside.
2. **Carry the labels through the session.** The labels belong to the session, not the file, so they still apply when later commands never mention the original file. Copying, renaming or summarizing the data doesn't wash them off.
3. **Judge outbound actions against the labels.** A call that sends data out is checked against what the session holds and where it's going.

This is the same idea as the capability tracking in Google DeepMind's [CaMeL](https://arxiv.org/abs/2503.18813) research, which attaches metadata to every value so that a policy can stop private data from flowing somewhere it shouldn't, whatever the model was talked into. CaMeL does it inside a purpose-built agent design. A data firewall applies a coarser version of the idea to agents you already run.

The payoff is that the decision depends on the *combination* rather than the command. `curl` to an outside host is fine on its own. `curl` to an outside host after reading a cloud key is the leak. `git push` is normal work, but after reading a secret it's worth a second look.

## What this looks like in practice

[Argox](https://www.getargox.com) is a data firewall for Claude Code and Python agents, which is our bias to declare. Here are decisions from its policy engine, produced by running the cases below:

| What the session has read | The agent tries to | Decision |
| --- | --- | --- |
| Nothing yet | read `.env` | <span class="v block">Blocked</span>: protected path |
| Nothing yet | `curl` the cloud metadata address | <span class="v block">Blocked</span>: credential endpoint |
| A secret | `curl -X POST` to an outside host | <span class="v block">Blocked</span>: secret leaving |
| A secret | `dig` a hostname on an outside domain | <span class="v block">Blocked</span>: DNS can carry data |
| A secret | `git push` | <span class="v ask">Asks you</span>: normal work, but check |
| Personal data | send it to an outside API | <span class="v ask">Asks you</span>: personal data leaving |
| A secret | call your own API (marked trusted) | <span class="v allow">Allowed</span> |
| A secret | `npm test` | <span class="v allow">Allowed</span>: nothing leaves |
| Text from a web page | an outbound call | <span class="v flag">Allowed, flagged</span>: possible injection |

The last row is deliberate. Agents that read the web and then call APIs are doing their job most of the time, so blocking would make the tool unusable. The flag records that outside content came before the call. The rows above it stop the damaging version, when sensitive data is held.

The limits are real too. A data firewall is only as good as its classification: a secret that doesn't look like one won't be labeled. And it doesn't stop harm that moves no data, such as deleting a database. Pair it with the containment controls above.

## Where the firewall runs matters

One design question separates serious products from demos: **can the agent skip the check?**

- **Inside the agent** (a library the agent's code calls): if the agent or its framework can take another code path, the check is skipped. This suits code you control end to end.
- **In the agent's harness** (Claude Code hooks, framework tool wrappers): the harness calls the check, not the model. A prompt injection can't talk the harness out of calling it. But a hook calling a remote service needs a decision about outages. Claude Code's docs note that a timed-out `PreToolUse` hook doesn't block the call unless you set `"onFailure": "block"`.
- **Outside the process** (a proxy or jail): nothing the agent does avoids it, but it sees network bytes, not intent, and TLS hides content unless the proxy decrypts it.

A layered setup uses at least two: the harness or proxy for enforcement, the jail for containment.

## How to evaluate an AI agent firewall

Ask a vendor (us included) to show, not tell:

- [ ] **The allowed-destination test.** The agent reads a file containing a key, then posts it in a GitHub comment. What happens?
- [ ] **The disguise test.** `python3 -c "open('.env')"`, `strings .e*`, `base64 < .env`. Which ones are caught?
- [ ] **The DNS test.** Does a lookup of `<data>.attacker.example` count as sending data?
- [ ] **The false-positive test.** Run a normal day of work through it. How often does it interrupt you?
- [ ] **The outage test.** Kill its backend mid-session. Does the agent stop, or do calls go through unchecked?
- [ ] **The explanation test.** When it blocks something, does it tell you which earlier read caused it?
- [ ] **Coverage.** Shell, files, web fetches, MCP tools, sub-agents: which are checked before they run?

## FAQ

### Is an AI agent firewall the same as an AI firewall or LLM firewall?

Not usually. "AI firewall" and "LLM firewall" mostly describe prompt firewalls: filters on the text going into and out of a model. An AI agent firewall governs actions such as shell commands, file access, network calls and tool use. A product can do both, so check which one a vendor means.

### Do I need an AI agent firewall if I already use a sandbox?

A sandbox is the containment half. It limits where an agent can reach. It doesn't know what the agent read, so it can't tell an ordinary `git push` from one carrying your keys to an allowed host. Use the sandbox for containment and a data-aware check for the channels you have to leave open.

### Can an AI agent firewall stop prompt injection?

It can't stop the model from being persuaded. Detection-based defenses keep being beaten by [adaptive attackers](https://arxiv.org/abs/2510.09023). What it can do is stop the *consequence*: the persuaded agent's attempt to send your data somewhere or run something destructive. That's a more reliable promise because it doesn't depend on detecting the injection.

### What is an AI agent data firewall?

An AI agent data firewall is an action firewall that tracks what sensitive data an agent has read (secrets, personal data, internal documents) and checks every outbound action against it. It blocks or asks for approval when that data is about to leave, rather than judging each command in isolation.

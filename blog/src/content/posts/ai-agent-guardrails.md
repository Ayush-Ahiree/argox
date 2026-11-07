---
title: "AI agent guardrails: what they catch, what they miss, and what the research says"
description: "Guardrails for AI agents explained: input, output and tool guardrails, what the 2025 research measured against them, and the design patterns that hold up when a filter doesn't."
pubDate: 2026-11-07
tags: ["Guardrails", "Prompt injection", "Guides"]
keyword: "AI agent guardrails"
hue: 320
glyph: "⫼"
---

"Add guardrails" is the most common answer to "how do we make our AI agent safe?", and the least specific. The word covers a moderation model on user prompts, a regex on the final answer, a check on every tool call, and an architecture that keeps untrusted text away from dangerous tools. These behave very differently under attack.

This guide separates the kinds of **AI agent guardrails**, shows exactly where a popular implementation runs and where it doesn't, and summarizes what the 2025 research measured when people tried to break them. The short answer: classifier guardrails lower the attack rate, and only structural guardrails give anything like a guarantee.

<aside class="tldr">
<span class="label">The short version</span>

1. **Classifier guardrails** (models that detect injections or bad output) reduce attacks a lot on benchmarks and lose to attackers who adapt.
2. **Tool guardrails** check actions instead of words. They're more reliable, but only for the tools they're attached to.
3. **Structural guardrails** (how the agent is built: plans fixed in advance, quarantined readers, data-flow policies) are the only kind with provable properties, and they cost some capability.
4. Use all three, and judge any vendor by what they claim against an *adaptive* attacker.
</aside>

## The three kinds of AI agent guardrails

| Kind | What it checks | Example | Fails when |
| --- | --- | --- | --- |
| Classifier | Text in and out of the model | Prompt-injection detectors, moderation models | The attack doesn't look like an attack |
| Tool | A tool call's arguments and results | Tool guardrails in agent SDKs, Claude Code hooks | The harmful action uses an unguarded tool, or looks harmless out of context |
| Structural | Which data can reach which tools | Plan-then-execute, dual LLM, capability tracking | Rarely in theory; in practice they limit what the agent can do |

Most products called "guardrails" are the first kind. Most incidents are stopped by the second and third.

## A concrete example: where guardrails run in the OpenAI Agents SDK

The details of a real implementation are more useful than any diagram. The [OpenAI Agents SDK guardrails docs](https://openai.github.io/openai-agents-python/guardrails/) define three types, and each has a specific scope:

- **Input guardrails** "run only for the first agent in the chain". They check the user's input. By default they run *in parallel* with the agent, and the docs warn that the agent "may have already consumed tokens and executed tools before being cancelled." Setting `run_in_parallel=False` makes them finish first.
- **Output guardrails** "run only for the agent that produces the final output." They check the answer, after all the work is done.
- **Tool guardrails** wrap function tools, checking inputs before the tool runs and outputs after. They don't cover everything: "tool guardrails do not apply to the handoff call itself", and hosted tools and built-in execution tools "do not use this guardrail pipeline."

None of this is a criticism of the SDK. The scoping is documented and sensible. But it shows why "we have guardrails" isn't an answer. An input guardrail never sees a malicious web page the third agent fetched. An output guardrail sees the final answer, not the API call that already sent your data. In the default parallel mode, tool calls can happen before the input check finishes. The security question is always **which guardrail is on the path the attack takes**.

## What the research measured

### Classifiers reduce attacks on benchmarks

Meta's [LlamaFirewall](https://arxiv.org/abs/2505.03574) (May 2025) is one of the best-documented guardrail systems, used in production at Meta and released as open source. It combines PromptGuard 2, a small classifier that flags jailbreak and injection text, with AlignmentCheck, an LLM that audits the agent's reasoning for signs it has been redirected. On the AgentDojo benchmark of agent tasks with injected attacks, Meta reported:

| Configuration | Attack success | Tasks completed |
| --- | --- | --- |
| No guardrail | 17.6% | 47.7% |
| PromptGuard 2 | 7.5% | 47.0% |
| AlignmentCheck | 2.9% | 43.1% |
| Both | 1.75% | 42.7% |

That's a large reduction at a modest cost in utility. The paper itself calls AlignmentCheck experimental, notes its "significantly higher latency", and notes it can itself be targeted by injection.

### Adaptive attackers break classifiers anyway

Five months later, [*The Attacker Moves Second*](https://arxiv.org/abs/2510.09023) (October 2025), by 14 researchers including Nicholas Carlini, Milad Nasr and Florian Tramèr, took 12 published defenses against jailbreaks and prompt injection and attacked each one with methods adapted to its design: gradient-based search, reinforcement learning, random search and human red-teamers. Most of those defenses had originally reported near-zero attack success. The adaptive attacks succeeded more than 90% of the time against most of them.

The paper's main point is about evaluation. A defense tested against a fixed list of known attack strings tells you how it does against attackers who don't know it exists. Real attackers iterate. Simon Willison [summed up](https://simonw.substack.com/p/new-prompt-injection-papers-agents) the lesson: static example attacks are an almost useless way to evaluate these defenses.

Both results can be true at once. Classifiers cut the volume of commodity attacks, which is worth having. They don't stop a motivated attacker who can try again, and a prompt injection in a public GitHub issue can be retried forever.

## Guardrails that hold up: the structural patterns

If filters can't be trusted to recognize every attack, the alternative is to arrange the agent so that a successful injection can't do anything damaging. In June 2025, researchers from organizations including IBM, Invariant Labs, ETH Zurich, Google and Microsoft published [*Design Patterns for Securing LLM Agents against Prompt Injections*](https://arxiv.org/abs/2506.08837). Its principle: once an agent has read untrusted input, it must be constrained so that input can't trigger consequential actions. It describes six patterns:

1. **Action-selector.** The agent picks from a fixed menu of actions and never sees their results, so tool output can't steer it.
2. **Plan-then-execute.** The agent commits to its list of tool calls *before* reading untrusted data. An injection can change arguments within the plan but can't add a new action, such as "now email this to me".
3. **LLM map-reduce.** Untrusted documents are each processed by an isolated sub-agent whose output is constrained, such as a yes/no or a number, before anything is combined.
4. **Dual LLM.** A privileged model plans and calls tools but never reads untrusted text. A quarantined model reads it and has no tools, and hands back only references the privileged model can't be instructed through.
5. **Code-then-execute.** The agent writes a program up front that specifies tool calls and data flow, which can then be checked and tracked.
6. **Context minimization.** Remove text the agent no longer needs, including the original prompt, so it can't be reused against it later.

Google DeepMind's [CaMeL](https://arxiv.org/abs/2503.18813) (March 2025) is the most developed version of these ideas. It turns the user's request into a small program, runs untrusted data only through a quarantined model, and attaches capabilities to every value recording where it came from and who may see it. Policies are enforced at each tool call, so private data can't flow to an unauthorized destination regardless of what the model was persuaded to do. On AgentDojo, CaMeL completed 77% of tasks with provable security, against 84% for an undefended agent.

That 7-point drop is the price of a guarantee. The LlamaFirewall and CaMeL evaluations used different models and setups, so the numbers don't compare directly, but both show the same shape: real protection costs some capability. For structural guardrails, the bigger cost is engineering: these patterns mean designing the agent around them, which isn't possible for a general-purpose coding agent you didn't build.

## A practical guardrail stack for agents you didn't build

Most teams run agents they didn't design: Claude Code, Cursor, Copilot, a framework template. You can't rebuild them as dual-LLM systems. You can approximate the structural ideas at the tool boundary:

- **Keep classifiers at the edges.** Screen user prompts and fetched content to cut noise. Don't count on them for anything critical.
- **Put deterministic checks on every tool call.** Protected paths, credential files, environment dumps and the cloud metadata address can be blocked outright, whatever the model intended. In Claude Code that's [deny rules and `PreToolUse` hooks](../stop-claude-code-reading-env-secrets/). In SDKs it's tool guardrails, with a check on what isn't covered (handoffs, hosted tools).
- **Track data, not just commands.** This is the poor man's CaMeL: label what the session reads (secrets, personal data, untrusted text) and check outbound calls against those labels. It's what an [AI agent firewall](../what-is-an-ai-agent-firewall/) with data tracking does, and it's what [Argox](https://www.getargox.com) does for Claude Code and Python agents.
- **Shrink the blast radius.** Scoped tokens, read-only database roles, and a sandbox with a short domain list. When a guardrail fails, these decide how bad it gets.
- **Apply the Rule of Two to sessions.** Meta's [Agents Rule of Two](https://ai.meta.com/blog/practical-ai-agent-security/) says a session should combine at most two of: untrusted input, sensitive data, and the ability to change state or communicate. When a session needs all three, that's where to require a human.

## Questions to ask about any guardrail product

- **Against which attacker?** Was it evaluated against adaptive attacks, or a fixed dataset? "99% detection" on a static set says little.
- **Where does it run?** On user input only, or on tool output, fetched pages and files too? Before tool calls, or after the answer?
- **Does it block or just score?** And if it's asynchronous, can the agent act before the verdict arrives?
- **What isn't covered?** Every implementation has unguarded paths. A good vendor lists them.
- **What happens when it fails?** If the guardrail service times out, does the agent stop or continue?

## FAQ

### What are AI agent guardrails?

AI agent guardrails are checks that constrain what an AI agent accepts, produces or does. They include classifiers on prompts and outputs, validators on tool-call arguments and results, and architectural limits on which data can reach which tools.

### What's the difference between guardrails and an AI agent firewall?

The terms overlap. "Guardrails" usually means checks built into an agent or its SDK, often classifiers on text. "AI agent firewall" usually means an enforcement layer on the agent's actions, such as tool calls, file access and network traffic, that the agent can't switch off. A tool guardrail is a small firewall around one tool.

### Do guardrails stop prompt injection?

Classifier guardrails reduce it but don't stop it. Research in 2025 showed adaptive attacks beating most published defenses more than 90% of the time. Structural guardrails, which keep injected text from triggering consequential actions, are the approach with provable properties.

### Are LLM guardrails enough for AI agents?

No. LLM guardrails check text, and an agent's damage is done through actions. An agent can write a perfectly polite reply while a tool call sends your data elsewhere. Agents need checks on tool calls and on the data flowing through them.

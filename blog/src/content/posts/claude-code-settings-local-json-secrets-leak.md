---
title: "How Claude Code's settings.local.json leaked thousands of secrets, and how to check yours"
description: "Approved commands are saved verbatim, keys and all, to .claude/settings.local.json. How the leak works, how to check your repos, and how to stop it."
pubDate: 2026-11-12
tags: ["Claude Code", "Secrets", "Incidents"]
keyword: "claude code settings.local.json secrets"
hue: 18
glyph: "⚿"
---

This week, researchers at Apiiro reported that they had found [more than 104,000 copies](https://arstechnica.com/ai/2026/11/claude-code-settings-files-expose-thousands-of-secrets-on-github/) of Claude Code's `.claude/settings.local.json` in public GitHub repositories. 1,122 of them contained real secrets. Following the trail through git history and other shared files, they counted 2,539 distinct credentials across nearly 2,000 repositories: database passwords, cloud keys, API tokens and SSH credentials, some of them belonging to companies.

No one was attacked, and no prompt injection was involved. The leak came from a convenience feature working exactly as designed. That makes it worth understanding: the same thing is probably sitting on your disk right now.

<aside class="tldr">
<span class="label">TL;DR</span>

1. When you approve a command with "Yes, and don't ask again", Claude Code saves the **exact command text** as an allow rule in `.claude/settings.local.json`. If the command contained a key, so does the file.
2. That file is kept out of git by a **global** ignore entry on your machine, not by the repo. Clone the project elsewhere, or turn a folder into a repo later, and the protection is gone.
3. Check now: `git log --all -- .claude/settings.local.json` in every repo you've used Claude Code in.
4. If a key was ever committed and pushed, **rotate it first**. Deleting the file doesn't remove it from history or forks.
5. The lasting fix is to never let a secret appear in a command at all. Commands should reference `$ENV_VARS`.
</aside>

## How a key ends up in a settings file

Say Claude needs to check that your OpenAI key works. It has read the key from your config, so it writes the command with the value inline:

```bash
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer sk-proj-4f9Q...x7Lw"
```

Claude Code asks permission. You're mid-task, the command looks harmless, and you pick **"Yes, and don't ask again"**. Claude Code now records an allow rule so the same command won't prompt next time:

```json
{
  "permissions": {
    "allow": [
      "Bash(curl https://api.openai.com/v1/models -H \"Authorization: Bearer sk-proj-4f9Q...x7Lw\")"
    ]
  }
}
```

The key now lives in a plain-text JSON file inside your project. The same thing happens with `PGPASSWORD=... psql`, `mysql -pPassword`, `export STRIPE_SECRET_KEY=...` and `curl -u admin:password`: anything Claude typed out in full and you approved permanently.

## Why the gitignore didn't save them

Claude Code does try to keep this file private. According to the report, it adds `settings.local.json` to your user's **global** git ignore list. That protects the file on the machine where the entry was added, as long as the repo was set up the normal way. It fails in the cases Apiiro found:

- **The project moves.** Clone it on another laptop, a CI runner or a teammate's machine, and that machine's global ignore list may not have the entry.
- **The repo comes later.** You start in a plain folder, approve a few commands, then `git init && git add .`
- **The agent commits it.** The report says Claude Code has in some cases committed changes to the file itself.

A rule in your *global* config is invisible to everyone else who touches the repo. The fix is a line in the *project's* `.gitignore`, which travels with the code.

## Why secret scanners missed some of them

Apiiro ran two widely used scanners, Gitleaks and TruffleHog, over the affected files. Together they missed **215 of the 1,122**. Scanners recognize secrets mostly by shape: `AKIA…` for AWS, `sk-…` for OpenAI, `ghp_…` for GitHub. A database password has no shape. In `mysql -u root -pWinter2026! app`, the only clue that `Winter2026!` is a password is the `-p` in front of it. If your safety net is "the scanner will catch it", these leaks go straight through.

## Check your repos now

Run these in every repository where you've used Claude Code:

```bash
# is the file tracked right now?
git ls-files .claude/

# was it EVER committed, on any branch?
git log --all --oneline -- .claude/settings.local.json

# what's in it locally? look for keys, passwords, tokens, connection strings
cat .claude/settings.local.json
```

Also check your global ignore list, since the report says that's where Claude Code puts the entry:

```bash
git config --global core.excludesFile   # then look for settings.local.json in that file
```

If you use Argox, `npx @amisecured/argox scan` runs these checks for you. It looks for secrets in `.claude/settings.local.json`, `.claude/settings.json`, `.mcp.json`, `CLAUDE.md` and leftover `.bak` copies, says whether each file is committed, and checks git history. Scanning is local; nothing is uploaded.

## If you find something

Order matters here.

1. **Rotate the credential first.** If the repo was ever pushed anywhere public, assume the key has already been collected; scrapers watch GitHub for exactly this. Generate a new key and revoke the old one before cleaning anything up.
2. **Stop tracking the file and ignore it in the project:**

   ```bash
   git rm --cached .claude/settings.local.json
   echo ".claude/settings.local.json" >> .gitignore
   git commit -m "Stop tracking Claude Code local settings"
   ```

3. **Remove the secret from the allow rule.** Edit the file and delete the entry, or replace the value with an environment variable reference.
4. **Decide about history.** Tools like `git filter-repo` can strip the file from history, followed by a force push. That's worth doing, but it doesn't reach existing forks, clones or caches. Step 1 is the real fix; this is cleanup.

## Preventing it

**Keep secrets out of commands.** This is the root cause, and the only fix that covers every copy at once. A command that says `"$OPENAI_API_KEY"` instead of the value can be approved, saved, logged and committed without leaking anything. The same goes for shell history and session transcripts, which store commands verbatim too.

**Be stingy with "don't ask again".** Before approving permanently, read the command for anything that looks like a credential. If there is one, approve once instead, or deny and ask Claude to use the environment variable.

**Put the ignore rule in the repo.** Add `.claude/settings.local.json` to the project's `.gitignore` today, even if your global config already covers it.

**Don't rely on pattern scanners alone.** They catch well-known key formats and miss passwords in command lines, which is a large part of what leaked here.

## Where Argox fits

[Argox](https://www.getargox.com) runs as a Claude Code hook and sees each command *before* it runs, which is also before it can be approved and saved. For this leak, that's the right place to stand. These are real decisions from its policy engine:

| Claude tries to | Decision |
| --- | --- |
| `curl -H "Authorization: Bearer sk-proj-…" https://api.openai.com/…` | <span class="v block">Blocked</span>: told to use `$OPENAI_API_KEY` instead |
| `mysql -u root -pS3cretPw99 app` | <span class="v block">Blocked</span>: password passed as a flag |
| `export STRIPE_SECRET_KEY=sk_live_…` | <span class="v block">Blocked</span>: key typed into the shell |
| `psql postgres://app:S3cretPw99@db…/prod` | <span class="v block">Blocked</span>: password in a connection string |
| `curl -H "Authorization: Bearer $OPENAI_API_KEY" …` | <span class="v allow">Allowed</span> |
| `git add .claude/settings.local.json` | <span class="v block">Blocked</span>: local settings must not be committed |
| Write a token into `.mcp.json` or `.claude/settings.json` | <span class="v block">Blocked</span>: shared agent config |
| Hardcode a key into `src/client.ts` | <span class="v ask">Asks you</span> |

When Argox blocks a command, it tells Claude why, so Claude rewrites it with the environment variable and carries on. Since the key never appears in a command, nothing with a key in it is ever offered for "don't ask again". Argox also masks secrets before anything reaches its own dashboard, so its event log doesn't become another place where keys pile up.

Its limits matter as much:

- It **can't clean up the past**. Files and history that already contain keys need the steps above. `argox scan` finds them; you still rotate and clean up.
- It **only sees calls Claude makes through the hook**. Commands you type into your own terminal, or approvals made before Argox was installed, aren't covered.
- Detection is **pattern- and flag-based**. A password passed to a tool through an unusual flag Argox doesn't know can still get through. That's why the habit of using environment variables matters more than any tool.

## Checklist

- [ ] Run `git log --all -- .claude/settings.local.json` in every repo you've used Claude Code in.
- [ ] Rotate anything that was ever committed and pushed, before cleaning up.
- [ ] `git rm --cached` the file and add `.claude/settings.local.json` to each project's `.gitignore`.
- [ ] Remove literal secrets from existing allow rules.
- [ ] Get in the habit of `"$VAR"` in commands, and don't approve "don't ask again" on anything with a credential in it.
- [ ] Add a check that stops secrets from being typed into commands in the first place.

For the wider picture of how agents reach secrets in the first place, see [Keeping secrets away from Claude Code](../stop-claude-code-reading-env-secrets/).

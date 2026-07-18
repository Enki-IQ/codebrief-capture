# Codebrief Capture

Distills developer decisions, plans, deferrals, and constraints from Claude Code or
Codex sessions, then sends only bounded and scrubbed intent annotations to your
Codebrief workspace. It never sends source code or transcripts to Codebrief.

## Install For Codex

```sh
codex plugin marketplace add Enki-IQ/codebrief-capture
codex plugin add codebrief-capture@codebrief
```

Start a new Codex thread after installation so the skills and hooks are loaded. The
plugin works in Codex CLI and in Conductor Codex workspaces without extra Conductor
configuration.

## Install For Claude Code

```sh
claude plugin marketplace add Enki-IQ/codebrief-capture
claude plugin install codebrief-capture@codebrief
```

It works in any terminal that runs Claude Code, including integrated IDE terminals.

## Use

1. Create a CLI key in Codebrief under **Settings > Connected CLIs**.
2. Ask the agent to use the `codebrief-login` skill. Browser authorization is preferred;
   the fallback hidden prompt keeps a pasted key out of the conversation and shell history.
3. Login automatically enables capture when run in a connected git repository. Use the
   `codebrief-enable` or `codebrief-disable` skill to change the current repository.
4. Use `codebrief-status` to check login, host CLI availability, distillation model, and
   enabled repositories. Use `codebrief-logout` to remove local credentials.

Claude captures at session end and in the background after a successful `git push` or
`gh pr create`. Codex captures after 45 seconds of end-of-turn inactivity and immediately
after those same successful publish commands. Repeated Stop events and publish hooks for
the same transcript revision are deduplicated.

Claude login/enable also adds a `Codebrief: capturing` (or `off`) segment to Claude
Code's status line. The Codex package does not modify Claude settings.

## Privacy And Cost

No transcript content is sent to Codebrief. Distillation context goes only to the
user's configured host provider. The Codex package structurally reduces the local
rollout first, excluding system instructions, reasoning, tool output, images, and world
state, then sends that reduced text through an ephemeral, read-only `codex exec` child
with hooks and plugins disabled and MCP servers cleared. Claude sends a bounded recent
transcript tail through an equivalent non-persistent `claude -p` child under the user's
Anthropic account.

The derived records are scrubbed and bounded again before Codebrief ingestion. Provider
calls run under the user's own Claude or Codex account; Codebrief is never billed for
distillation.

Claude defaults to `sonnet`; override `distillModel` in `~/.codebrief/config.json` or
set `CODEBRIEF_DISTILL_MODEL`. Codex uses the user's default model with low reasoning;
override `codexDistillModel`, `codexDistillReasoningEffort`, or the corresponding
`CODEBRIEF_CODEX_DISTILL_MODEL` and `CODEBRIEF_CODEX_REASONING_EFFORT` environment
variables. `codexDebounceMs` or `CODEBRIEF_CODEX_DEBOUNCE_MS` controls the idle delay.

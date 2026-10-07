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

## Update An Existing Installation

For Codex:

```sh
codex plugin marketplace upgrade codebrief
codex plugin add codebrief-capture@codebrief
```

For Claude Code:

```sh
claude plugin marketplace update codebrief
claude plugin update codebrief-capture@codebrief
```

Claude updates default to user scope; add `--scope project` or `--scope local` if that
matches your existing installation. Start a new Codex thread or restart Claude Code
so the updated skills load. Native agent pairing requires Capture `0.9.0` or later.

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

## Connect Your Native Agent

Codebrief's **Settings > Connected agents** page guides you through native sign-in,
Capture installation, Codebrief authorization and pairing. Agent pairing requires Capture
`0.9.0` or later. After installing or updating, start a new native session so the
`codebrief-login` and `codebrief-agents` skills are available.

Sign in to Claude Code or the local Codex CLI using its own login flow. In your connected
repository, ask the agent to use `codebrief-login` and authorize the device in your browser.
Then create a pairing on the Connected agents page and copy its instruction into that
same native session. The instruction invokes the installed `codebrief-agents` skill with
`agents connect --provider claude|codex --pairing <pairing ID>`; `agents` is a skill argument,
not a global terminal executable. Pairings expire after five minutes.

Refresh Connected agents to inspect the observed connection. Provider credentials stay
local. Sign-in and pairing do not establish model entitlement or allow Codebrief to use
subscription credentials as API keys. New Codebrief-started Codex sessions are unavailable
pending supported integration eligibility. Claude request notifications occur at supported
checkpoints; Codex requests require manual inbox reads.

## Active Project Work

When Active Project execution is enabled for your organization, an editor or member can
queue a guided action in Codebrief and pass its opaque locator to the connected coding
host:

```text
$codebrief-work <locator>
```

Run `$codebrief-work` without a locator to list available work for the current
repository. The skill claims one action, restates its bounded contract, and reminds the
agent to verify suggested files and tests locally. The host uses its normal repository
permissions; Codebrief does not execute code.

At a terminal outcome, use `$codebrief-return`. The skill validates a bounded result
locally and submits it on stdin, never in command-line arguments. Codebrief shows the
result as a proposal for explicit editor review. Completed, blocked, no-change, and
explicit partial outcomes are supported.

Active Project results require Codebrief Capture `0.8.0` or later. The return contract
is facts-only and contains exactly these fields:

```json
{
  "schemaVersion": 2,
  "outcome": "completed",
  "checks": [
    { "kind": "tests", "status": "passed" },
    { "kind": "lint", "status": "passed" }
  ],
  "references": [],
  "blockers": []
}
```

Check kinds are `tests`, `lint`, `types`, `build`, and `review`; statuses are
`passed`, `failed`, and `not_run`. `references` is required but must be empty; Codebrief
uses server-owned handoff provenance instead of accepting transcript-derived locators.
Blockers are limited to `dependency`, `permissions`, `environment`, `review`, and
`unknown`. The contract rejects unknown keys, prose fields, non-empty references, and
duplicate check kinds. A `completed` result has no blockers; a `blocked` result has at
least one.

Keys created before Active Project execution was added need browser reauthorization.
Run `codebrief-login` again and approve the additive Active Project scopes.

Active handoff markers are stored as mode `0600` files under
`~/.codebrief/active-project/`; validated results awaiting a retry are stored under
`~/.codebrief/outbox/`. Both directories are mode `0700`. Set
`CODEBRIEF_CONFIG_DIR` only when intentionally relocating all Codebrief local state.
Failed result delivery keeps one bounded, validated outbox entry so a later explicit
return or host hook can retry without creating a duplicate proposal.

## Privacy And Cost

No transcript content is sent to Codebrief. Distillation uses one model CLI for every
capture host (Claude Code, Codex, or Conductor). The default is `gemini` with
`gemini-3.8-flash`. Set `CODEBRIEF_DISTILL_COMMAND` to another executable that accepts
`--prompt`, `--model`, `--schema-file`, and `--output-format json`, and set
`CODEBRIEF_DISTILL_MODEL` or `distillModel` to another `gemini-` model id. Other model
ids are ignored.

The derived records are scrubbed and bounded again before Codebrief ingestion. The model
call runs under the user's own account for that CLI; Codebrief is never billed for
distillation.

Active Project handoffs preserve the same boundary. Codebrief receives the action
contract and the facts-only v2 result fields only. Capture never uploads prose result
fields, source code, diffs, patches, transcripts, reasoning, tool output, raw command
output, environment values, or credentials.

Override `distillModel` in `~/.codebrief/config.json` or set `CODEBRIEF_DISTILL_MODEL`.
`codexDebounceMs` or `CODEBRIEF_CODEX_DEBOUNCE_MS` controls the Codex idle delay.

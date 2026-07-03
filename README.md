# Codebrief Capture

Distills developer intent locally — at session end, after `git push`, or after `gh pr create` — and sends only derived annotations (never code or transcripts) to your Codebrief workspace.

## Install

    claude plugin marketplace add Enki-IQ/codebrief-capture
    claude plugin install codebrief-capture@codebrief

Works in any terminal that runs Claude Code, including the Cursor integrated terminal.

## Use

1. Create a CLI key in the Codebrief dashboard (**Settings → Connected CLIs**) and copy it (shown once).
2. `/codebrief:login` — run it in your terminal and paste the key at the **hidden prompt**; it's stored in your OS keychain and never enters the chat. If you're in a connected git repo, this also enables capture for that repo.
3. `/codebrief:enable` — turn on capture for a different repo (or re-enable one you disabled).
4. Work normally. Intent is distilled locally and sent at session end, and also right after a `git push` or `gh pr create` (in the background — it never blocks you).
5. `/codebrief:status` — login state, whether the `claude` CLI is found, and which repos are enabled.
6. `/codebrief:disable` — stop capturing the current repo. `/codebrief:logout` — clear credentials.

Nothing but bounded, scrubbed intent annotations leaves your machine; distillation runs under your own Claude Code.

## Cost

Distillation calls `claude -p` under **your own** Anthropic account, once per capture (session end, push, or PR create — Codebrief is never billed for it). It defaults to `sonnet` for distill quality. To reduce per-session cost, set `distillModel` in `~/.codebrief/config.json` (or `CODEBRIEF_DISTILL_MODEL`) to a cheaper model, e.g. `"haiku"`.

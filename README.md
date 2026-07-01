# Codebrief Capture

Distills developer intent locally at session end and sends only derived annotations (never code or transcripts) to your Codebrief workspace.

## Install

    claude plugin marketplace add Enki-IQ/codebrief-capture
    claude plugin install codebrief-capture@codebrief

Works in any terminal that runs Claude Code, including the Cursor integrated terminal.

## Use

1. Create a CLI key in the Codebrief dashboard (**Settings → Connected CLIs**) and copy it (shown once).
2. `/codebrief:login` — run it in your terminal and paste the key at the **hidden prompt**; it's stored in your OS keychain and never enters the chat.
3. `/codebrief:enable` — turn on capture for the current repo.
4. Work normally. At session end, intent is distilled locally and sent.
5. `/codebrief:status` — login state, whether the `claude` CLI is found, and which repos are enabled.
6. `/codebrief:disable` — stop capturing the current repo. `/codebrief:logout` — clear credentials.

Nothing but bounded, scrubbed intent annotations leaves your machine; distillation runs under your own Claude Code.

## Cost

Distillation calls `claude -p` under **your own** Anthropic account, once per session end (Codebrief is never billed for it). It defaults to `sonnet` for distill quality. To reduce per-session cost, set `distillModel` in `~/.codebrief/config.json` (or `CODEBRIEF_DISTILL_MODEL`) to a cheaper model, e.g. `"haiku"`.

---
name: codebrief-return
description: Use when claimed Codebrief Active Project work reaches a completed, blocked, no-change, or explicit partial outcome.
---

# Codebrief Return

Return only a terminal outcome: `completed`, explicit `partial`, `blocked`, or
`no_change`. Do not return while implementation or verification is still in progress.

Construct one bounded JSON object with:

- `schemaVersion: 2`
- `outcome`
- `checks` containing only `kind` and `status`; kinds are `tests`, `lint`, `types`,
  `build`, and `review`, and statuses are `passed`, `failed`, and `not_run`
- `references: []`
- up to five unique `blockers` chosen from `dependency`, `permissions`,
  `environment`, `review`, and `unknown`

Use each check kind at most once. Never derive or copy a commit, pull request, file
path, or other locator from the transcript; Codebrief attaches server-owned handoff
provenance. `completed` has no blockers; `blocked` has at least one blocker. Do not add
any other keys. Never include prose, source code, patch text, diffs, transcript
excerpts, complete tool output, credentials, secrets, or invented evidence.

Resolve `SKILL_DIR`, then use a filesystem-writing tool to place only that JSON in a new
restrictive temporary file outside the repository. Do not construct the JSON in a
shell command. Set mode `0600`, pass it to the local validator and submitter on stdin,
then remove it:

```sh
chmod 600 "$RESULT_FILE"
node "$SKILL_DIR/../../scripts/codex-active-project-return.js" < "$RESULT_FILE"
rm -f "$RESULT_FILE"
```

Never put result text in argv. The adapter validates and bounds the result before
submission. On a transient failure it keeps only the validated structured result in
the restrictive local outbox for a later hook retry.

## Tandem protocol 1 (default disabled)

Use literal commands `codebrief-cli tandem brief`, `codebrief-cli tandem claim claim.json`, `codebrief-cli tandem heartbeat`, `codebrief-cli tandem checkpoint checkpoint.json`, `codebrief-cli tandem return result.json`, `codebrief-cli tandem review`, and `codebrief-cli tandem recover recovery.json` through this package's CLI script. Heartbeat is explicit active work only. Never renew from polling or a Capture hook. An unsupported server fails these commands explicitly; ordinary Capture remains available.

Claim input contains handoffId, expectedActionVersion, requestId (UUID), canonicalScope (exact file/directory grants), and host. Checkpoint remains local, exact schema, scrubbed and bounded to128KiB; supply baseSha, dirty/untracked arrays, decisions, command observations (command,exitStatus,time,revision), nextSteps and unresolvedRisks. The client supplies authenticated namespace/action/attempt/generation, checks hosted ownership, and derives actual Git inventories. Dirty or out-of-scope work is never ready for return.

Return input contains only existing schemaVersion2 result and separate schemaVersion1 author receipt (attemptId,actionVersion,authorInstanceId,generation,baseSha,headSha,contractDigest,evidenceDigest). Never attach source, prose, checkpoints, paths or tool output. Results persist before submission; keep overflow files and resolve the visible recovery error. Recovery requires disposition resume/replace and stoppedAttestation true after confirming the prior process stopped; durable request replay handles lost rotated responses. Adopt the complete returned Claim and credential atomically. Review and brief producers are implemented. New claims, review claims and resumed/replacement work require the current rollout flags and exact repository pilot policy; flags remain disabled by default. Current authenticated brief/ownership reads, exact committed replay, renewals, result return and Stop/reconciliation remain available under their existing authority checks after rollback. Availability or a successful fixture never proves live activation.

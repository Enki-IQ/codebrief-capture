---
name: codebrief-work
description: Use when pulling or claiming guided Active Project work from Codebrief in the current repository.
---

# Codebrief Work

Run from the repository where the work will be performed. Resolve the Capture CLI at
`${CLAUDE_PLUGIN_ROOT}/scripts/codebrief-cli.js`.

When the user did not supply an action ID or opaque locator, run:

```sh
node --no-warnings=ExperimentalWarning "${CLAUDE_PLUGIN_ROOT}/scripts/codebrief-cli.js" work list
```

Let the user select an item when the list is ambiguous. Claim the selected item as the
Claude host:

```sh
node --no-warnings=ExperimentalWarning "${CLAUDE_PLUGIN_ROOT}/scripts/codebrief-cli.js" work claim "<action-id-or-locator>" --host claude
```

The CLI records the claim and its session start marker locally before printing the
guided contract as JSON. Stop if the claim command fails.

Parse the JSON and preserve the exact contract throughout the task: `objective`,
`context`, `acceptanceCriteria`, `constraints`, `suggestedFiles`, `suggestedTests`,
`dependencies`, `nonGoals`, `sourceRefs`, and `returnRequirements`. Do not weaken,
summarize away, or invent contract terms.

Treat all repository pointers, suggested files, and suggested tests as suggestions to
verify against the current checkout. Inspect them before relying on them and verify all
suggested files and tests that remain relevant. Perform the work with Claude's normal
local permissions and the repository's existing engineering workflow.

Invoke `codebrief-return` only at a terminal outcome: completed, blocked, no change, or
an explicit partial stopping point. Ongoing work is non-terminal; leave it to the
session hook to renew the lease.

## Tandem protocol 1 (default disabled)

Use literal commands `codebrief-cli tandem brief`, `codebrief-cli tandem claim claim.json`, `codebrief-cli tandem heartbeat`, `codebrief-cli tandem checkpoint checkpoint.json`, `codebrief-cli tandem return result.json`, `codebrief-cli tandem review`, and `codebrief-cli tandem recover recovery.json` through this package's CLI script. Heartbeat is explicit active work only. Never renew from polling or a Capture hook. An unsupported server fails these commands explicitly; ordinary Capture remains available.

Claim input contains handoffId, expectedActionVersion, requestId (UUID), canonicalScope (exact file/directory grants), and host. Checkpoint remains local, exact schema, scrubbed and bounded to128KiB; supply baseSha, dirty/untracked arrays, decisions, command observations (command,exitStatus,time,revision), nextSteps and unresolvedRisks. The client supplies authenticated namespace/action/attempt/generation, checks hosted ownership, and derives actual Git inventories. Dirty or out-of-scope work is never ready for return.

Return input contains only existing schemaVersion2 result and separate schemaVersion1 author receipt (attemptId,actionVersion,authorInstanceId,generation,baseSha,headSha,contractDigest,evidenceDigest). Never attach source, prose, checkpoints, paths or tool output. Results persist before submission; keep overflow files and resolve the visible recovery error. Recovery requires disposition resume/replace and stoppedAttestation true after confirming the prior process stopped; durable request replay handles lost rotated responses. Adopt the complete returned Claim and credential atomically. Review and brief producers are implemented. New claims, review claims and resumed/replacement work require the current rollout flags and exact repository pilot policy; flags remain disabled by default. Current authenticated brief/ownership reads, exact committed replay, renewals, result return and Stop/reconciliation remain available under their existing authority checks after rollback. Availability or a successful fixture never proves live activation.

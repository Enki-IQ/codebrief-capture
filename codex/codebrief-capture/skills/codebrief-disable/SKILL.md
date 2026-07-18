---
name: codebrief-disable
description: Disable Codebrief Capture for the git repository in the current Codex workspace.
---

# Codebrief Disable

Run from the repository the user wants to disable. Resolve `SKILL_DIR` to the absolute
directory containing this `SKILL.md`, then run:

```sh
node "$SKILL_DIR/../../scripts/codebrief-cli.js" disable
```

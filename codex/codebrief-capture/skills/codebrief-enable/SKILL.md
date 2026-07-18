---
name: codebrief-enable
description: Enable Codebrief Capture for the git repository in the current Codex workspace.
---

# Codebrief Enable

Run from the repository the user wants to enable. Resolve `SKILL_DIR` to the absolute
directory containing this `SKILL.md`, then run:

```sh
node "$SKILL_DIR/../../scripts/codebrief-cli.js" enable
```

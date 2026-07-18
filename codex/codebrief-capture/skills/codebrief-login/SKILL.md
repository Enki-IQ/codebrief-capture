---
name: codebrief-login
description: Log in Codebrief Capture from Codex using browser authorization or a secure local key prompt.
---

# Codebrief Login

Resolve `SKILL_DIR` to the absolute directory containing this `SKILL.md`, then run this
command in an interactive terminal:

```sh
node "$SKILL_DIR/../../scripts/codebrief-cli.js" login
```

Never ask the user to paste a Codebrief key into the conversation or place it in a
command argument. Let the browser flow or hidden local prompt collect it.

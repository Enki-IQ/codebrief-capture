---
name: codebrief-login
description: Authenticate the Codebrief capture CLI by authorizing it in your browser. Use when capture says you're not logged in.
allowed-tools: Bash(node *)
---

# Codebrief Login
Run the login command for the user — it opens their browser to a one-click **Authorize** page and receives the key locally over loopback, so no secret passes through this chat:

    node --no-warnings=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/codebrief-cli.js login

Tell the user: a browser tab will open — click **Authorize this device** (sign in to Codebrief first if prompted). When the CLI prints "Logged in.", confirm. If the browser can't open (e.g. headless), the CLI falls back to a hidden paste prompt the user runs themselves. Never handle or echo a key yourself.

function commandText(input) {
  const command = input?.tool_input?.command;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    return command.join("\n");
  }
  return "";
}

function toolSucceeded(response) {
  if (!response || typeof response !== "object") return true;
  if (response.is_error === true || response.isError === true || response.success === false || response.error) return false;
  if (["failed", "error", "cancelled"].includes(response.status)) return false;
  if (typeof response.status === "number" && response.status !== 0) return false;
  const exitCode = response.exit_code ?? response.exitCode ?? response.status?.exit_code;
  return exitCode === undefined || exitCode === null || exitCode === 0;
}

const ENV_PREFIX = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+)*`;
const COMMAND_PREFIX = String.raw`(?:command\s+)?(?:[^\s;&|]+\/)?`;
const GIT_OPTIONS = String.raw`(?:(?:(?:-C|-c|--git-dir|--work-tree)\s+[^\s;&|]+|--(?:no-pager|bare|literal-pathspecs|no-optional-locks))\s+)*`;
const GH_OPTIONS = String.raw`(?:(?:(?:-R|--repo|--hostname)\s+[^\s;&|]+|--(?:help|version))\s+)*`;

const PUSH_COMMAND = new RegExp(
  `^${ENV_PREFIX}${COMMAND_PREFIX}git\\s+${GIT_OPTIONS}push(?:\\s+.*)?$`,
);
const PR_CREATE_COMMAND = new RegExp(
  `^${ENV_PREFIX}${COMMAND_PREFIX}gh\\s+${GH_OPTIONS}pr\\s+create(?:\\s+.*)?$`,
);

function finalExecutedCommand(command) {
  if (!command || /[|;\n\r`()]/.test(command) || command.includes("$(")) return "";
  const segments = command.split("&&").map((part) => part.trim());
  if (segments.some((part) => !part || part.includes("&"))) return "";
  return segments.at(-1);
}

/** True only for a successful shell tool that actually executes a capture trigger. */
export function shouldCaptureAfterTool(input) {
  if (!toolSucceeded(input?.tool_response)) return false;
  const command = finalExecutedCommand(commandText(input));
  return PUSH_COMMAND.test(command) || PR_CREATE_COMMAND.test(command);
}

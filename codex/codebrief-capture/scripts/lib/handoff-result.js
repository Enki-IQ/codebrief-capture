const OUTCOMES = new Set(["completed", "partial", "blocked", "no_change"]);
const CHECK_KINDS = new Set(["tests", "lint", "types", "build", "review"]);
const CHECK_STATUSES = new Set(["passed", "failed", "not_run"]);
const BLOCKERS = new Set(["dependency", "permissions", "environment", "review", "unknown"]);

const RESULT_KEYS = new Set(["schemaVersion", "outcome", "checks", "references", "blockers"]);
const CHECK_KEYS = new Set(["kind", "status"]);
const MAX_RESULT_BYTES = 120 * 1024;

export class HandoffResultValidationError extends Error {
  constructor(field) {
    super(`Invalid handoff result: ${field}`);
    this.name = "HandoffResultValidationError";
    this.field = field;
  }
}

function record(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HandoffResultValidationError(field);
  }
  return value;
}

function closedRecord(value, field, allowedKeys, requiredKeys = allowedKeys) {
  const row = record(value, field);
  for (const key of Object.keys(row)) {
    if (!allowedKeys.has(key)) {
      throw new HandoffResultValidationError(field === "result" ? key : `${field}.${key}`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(row, key)) {
      throw new HandoffResultValidationError(field === "result" ? key : `${field}.${key}`);
    }
  }
  return row;
}

function array(value, field, maxItems) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new HandoffResultValidationError(field);
  }
  return value;
}

function normalizeCheck(value, index, seenKinds) {
  const field = `checks.${index}`;
  const row = closedRecord(value, field, CHECK_KEYS);
  if (!CHECK_KINDS.has(row.kind) || seenKinds.has(row.kind)) {
    throw new HandoffResultValidationError(`${field}.kind`);
  }
  if (!CHECK_STATUSES.has(row.status)) {
    throw new HandoffResultValidationError(`${field}.status`);
  }
  seenKinds.add(row.kind);
  return { kind: row.kind, status: row.status };
}

function normalizeBlockers(value) {
  const blockers = array(value, "blockers", 5);
  const seen = new Set();
  return blockers.map((blocker, index) => {
    if (!BLOCKERS.has(blocker) || seen.has(blocker)) {
      throw new HandoffResultValidationError(`blockers.${index}`);
    }
    seen.add(blocker);
    return blocker;
  });
}

export function validateHandoffResult(input, { maxBytes = MAX_RESULT_BYTES } = {}) {
  const row = closedRecord(input, "result", RESULT_KEYS);
  if (row.schemaVersion !== 2) {
    throw new HandoffResultValidationError("schemaVersion");
  }
  if (!OUTCOMES.has(row.outcome)) {
    throw new HandoffResultValidationError("outcome");
  }

  const seenKinds = new Set();
  const result = {
    schemaVersion: 2,
    outcome: row.outcome,
    checks: array(row.checks, "checks", CHECK_KINDS.size)
      .map((check, index) => normalizeCheck(check, index, seenKinds)),
    references: array(row.references, "references", 0),
    blockers: normalizeBlockers(row.blockers),
  };

  if (
    (result.outcome === "completed" && result.blockers.length !== 0)
    || (result.outcome === "blocked" && result.blockers.length === 0)
  ) {
    throw new HandoffResultValidationError("blockers");
  }
  if (
    !Number.isInteger(maxBytes)
    || maxBytes < 1
    || Buffer.byteLength(JSON.stringify(result), "utf8") > maxBytes
  ) {
    throw new HandoffResultValidationError("result");
  }
  return result;
}

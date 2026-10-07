import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HandoffResultValidationError,
  validateHandoffResult,
} from "./handoff-result.js";

function validResult(extra = {}) {
  return {
    schemaVersion: 2,
    outcome: "partial",
    checks: [
      { kind: "tests", status: "passed" },
      { kind: "lint", status: "not_run" },
    ],
    references: [],
    blockers: ["dependency"],
    ...extra,
  };
}

function rejectsField(input, field) {
  assert.throws(
    () => validateHandoffResult(input),
    (error) => error instanceof HandoffResultValidationError && error.field === field,
    field,
  );
}

test("normalizes a facts-only v2 result", () => {
  assert.deepEqual(validateHandoffResult(validResult()), {
    schemaVersion: 2,
    outcome: "partial",
    checks: [
      { kind: "tests", status: "passed" },
      { kind: "lint", status: "not_run" },
    ],
    references: [],
    blockers: ["dependency"],
  });
});

test("requires exactly the five v2 top-level fields", () => {
  for (const field of ["schemaVersion", "outcome", "checks", "references", "blockers"]) {
    const input = validResult();
    delete input[field];
    rejectsField(input, field);
  }

  for (const field of [
    "summary",
    "detail",
    "recommendedCurrentState",
    "recommendedGate",
    "recommendedNextAction",
    "transcript",
    "patch",
  ]) {
    rejectsField(validResult({ [field]: "arbitrary prose" }), field);
  }
  rejectsField(validResult({ schemaVersion: 1 }), "schemaVersion");
});

test("accepts only unique check kinds with closed fields and statuses", () => {
  for (const kind of ["tests", "lint", "types", "build", "review"]) {
    assert.deepEqual(
      validateHandoffResult(validResult({ checks: [{ kind, status: "passed" }] })).checks,
      [{ kind, status: "passed" }],
    );
  }
  for (const status of ["passed", "failed", "not_run"]) {
    assert.deepEqual(
      validateHandoffResult(validResult({ checks: [{ kind: "tests", status }] })).checks,
      [{ kind: "tests", status }],
    );
  }

  rejectsField(validResult({
    checks: [{ kind: "tests", status: "passed", label: "Focused tests" }],
  }), "checks.0.label");
  rejectsField(validResult({
    checks: [{ kind: "tests", status: "passed", detail: "12 passed" }],
  }), "checks.0.detail");
  rejectsField(validResult({
    checks: [
      { kind: "tests", status: "passed" },
      { kind: "tests", status: "failed" },
    ],
  }), "checks.1.kind");
  rejectsField(validResult({ checks: [{ kind: "security", status: "passed" }] }), "checks.0.kind");
  rejectsField(validResult({ checks: [{ kind: "tests", status: "unknown" }] }), "checks.0.status");
  rejectsField(validResult({ checks: "passed" }), "checks");
});

test("rejects every model-supplied reference locator", () => {
  for (const [type, locator] of [
    ["commit", "abcdef1"],
    ["pull_request", "42"],
    ["file", "src/app.js"],
    ["file", `ghp_${"A".repeat(36)}`],
    ["file", `glpat-${"A".repeat(24)}`],
    ["file", `sk_live_${"A".repeat(24)}`],
    ["file", `ASIA${"A".repeat(16)}`],
    ["file", Buffer.from("const secret = process.env.TOKEN").toString("base64url")],
    ["file", Buffer.from("USER: private transcript").toString("base64url")],
  ]) {
    rejectsField(validResult({
      references: [{ type, locator }],
    }), "references");
  }
});

test("enforces blocker enums, uniqueness, cardinality, and outcome invariants", () => {
  for (const blocker of ["dependency", "permissions", "environment", "review", "unknown"]) {
    assert.deepEqual(
      validateHandoffResult(validResult({ outcome: "blocked", blockers: [blocker] })).blockers,
      [blocker],
    );
  }

  rejectsField(validResult({ blockers: ["dependency", "dependency"] }), "blockers.1");
  rejectsField(validResult({
    blockers: ["dependency", "permissions", "environment", "review", "unknown", "dependency"],
  }), "blockers");
  rejectsField(validResult({ blockers: ["prose"] }), "blockers.0");
  rejectsField(validResult({ outcome: "completed", blockers: ["dependency"] }), "blockers");
  rejectsField(validResult({ outcome: "blocked", blockers: [] }), "blockers");

  for (const outcome of ["completed", "partial", "blocked", "no_change"]) {
    const blockers = outcome === "blocked" ? ["unknown"] : [];
    assert.equal(validateHandoffResult(validResult({ outcome, blockers })).outcome, outcome);
  }
  rejectsField(validResult({ outcome: "done" }), "outcome");
});

test("rejects malformed containers and oversized results", () => {
  rejectsField(null, "result");
  rejectsField([], "result");
  rejectsField(validResult({ references: {} }), "references");
  assert.throws(
    () => validateHandoffResult(validResult(), { maxBytes: 1 }),
    (error) => error instanceof HandoffResultValidationError && error.field === "result",
  );
});

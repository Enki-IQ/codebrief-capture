const MAX = 400;
const KINDS = new Set(["decision", "plan", "deferral", "constraint"]);
const SOURCE_TYPES = new Set(["session", "commit"]);
const SECRET = [
  /AKIA[0-9A-Z]{16}/, /AIza[0-9A-Za-z\-_]{35}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bck_(?:live|test)_[A-Za-z0-9_-]{10,}\b/, // Clerk API keys — this plugin's own egress credential
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\bASIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.\-]{8,}/i,
  /\b[a-z][a-z0-9+.\-]*:\/\/[^\s:@/]+:[^\s:@/]+@/,
];

/** Redact known secrets and fenced code before transcript text reaches a distillation provider. */
export function scrubTranscriptText(value) {
  if (typeof value !== "string") return "";
  let clean = value
    .replace(/```[\s\S]*?```|```[\s\S]*$/g, "[redacted code]")
    .replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g, "[redacted secret]");
  for (const pattern of SECRET) {
    clean = clean.replace(
      new RegExp(pattern.source, pattern.ignoreCase ? "gi" : "g"),
      "[redacted secret]",
    );
  }
  return clean;
}

export function preScrub(summary) {
  if (typeof summary !== "string" || !summary.trim()) return { ok: false };
  if (summary.length > MAX) return { ok: false };
  if (summary.includes("```")) return { ok: false };
  for (const re of SECRET) if (re.test(summary)) return { ok: false };
  return { ok: true };
}

export function preScrubMetadata(value, maxLength) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(normalized) || normalized.includes("```")) return undefined;
  for (const pattern of SECRET) if (pattern.test(normalized)) return undefined;
  return normalized;
}

/** Exact server-compatible contract for opaque Session capture provenance. */
export function normalizeSourceRef(value) {
  if (typeof value !== "string") return undefined;
  if (!value.trim() || value.length > 200) return undefined;
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value)) return undefined;
  return value;
}

function scrubAnchor(anchor) {
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) return undefined;
  const clean = {};
  const symbol = preScrubMetadata(anchor.symbol, 200);
  const path = preScrubMetadata(anchor.path, 500);
  if (symbol) clean.symbol = symbol;
  if (path) clean.path = path;
  if (Number.isInteger(anchor.startLine) && anchor.startLine >= 0) clean.startLine = anchor.startLine;
  if (Number.isInteger(anchor.endLine) && anchor.endLine >= 0) clean.endLine = anchor.endLine;
  return Object.keys(clean).length ? clean : undefined;
}

/** Allowlist and scrub the full outbound record shape; unknown model fields never reach ingest. */
export function preScrubRecords(records) {
  if (!Array.isArray(records)) return [];
  return records.flatMap((record) => {
    if (!record || typeof record !== "object" || !KINDS.has(record.kind) || !preScrub(record.summary).ok) return [];
    const clean = { kind: record.kind, summary: record.summary };
    if (SOURCE_TYPES.has(record.sourceType)) clean.sourceType = record.sourceType;
    const sourceRef = normalizeSourceRef(record.sourceRef);
    if (sourceRef) clean.sourceRef = sourceRef;
    const anchor = scrubAnchor(record.anchor);
    if (anchor) clean.anchor = anchor;
    return [clean];
  });
}

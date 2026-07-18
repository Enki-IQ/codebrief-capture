const MAX = 400;
const KINDS = new Set(["decision", "plan", "deferral", "constraint"]);
const SOURCE_TYPES = new Set(["session", "commit"]);
const SECRET = [
  /AKIA[0-9A-Z]{16}/, /AIza[0-9A-Za-z\-_]{35}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bck_(?:live|test)_[A-Za-z0-9_-]{10,}\b/, // Clerk API keys — this plugin's own egress credential
  /\b[a-z][a-z0-9+.\-]*:\/\/[^\s:@/]+:[^\s:@/]+@/,
];

/** Redact known secrets and fenced code before transcript text reaches a distillation provider. */
export function scrubTranscriptText(value) {
  if (typeof value !== "string") return "";
  let clean = value
    .replace(/```[\s\S]*?```|```[\s\S]*$/g, "[redacted code]")
    .replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g, "[redacted secret]");
  for (const pattern of SECRET) {
    clean = clean.replace(new RegExp(pattern.source, "g"), "[redacted secret]");
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
  if (typeof value !== "string" || !value || value.length > maxLength) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(value) || value.includes("```")) return undefined;
  for (const pattern of SECRET) if (pattern.test(value)) return undefined;
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
    const sourceRef = preScrubMetadata(record.sourceRef, 200);
    if (sourceRef) clean.sourceRef = sourceRef;
    const anchor = scrubAnchor(record.anchor);
    if (anchor) clean.anchor = anchor;
    return [clean];
  });
}

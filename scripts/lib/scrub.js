const MAX = 400;
const SECRET = [
  /AKIA[0-9A-Z]{16}/, /AIza[0-9A-Za-z\-_]{35}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{20,}/, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bck_(?:live|test)_[A-Za-z0-9_-]{10,}\b/, // Clerk API keys — this plugin's own egress credential
  /\b[a-z][a-z0-9+.\-]*:\/\/[^\s:@/]+:[^\s:@/]+@/,
];
export function preScrub(summary) {
  if (typeof summary !== "string" || !summary.trim()) return { ok: false };
  if (summary.length > MAX) return { ok: false };
  if (summary.includes("```")) return { ok: false };
  for (const re of SECRET) if (re.test(summary)) return { ok: false };
  return { ok: true };
}
/** Filter a record array, dropping ones whose summary fails the local pre-scrub. */
export function preScrubRecords(records) { return (records ?? []).filter((r) => preScrub(r?.summary).ok); }

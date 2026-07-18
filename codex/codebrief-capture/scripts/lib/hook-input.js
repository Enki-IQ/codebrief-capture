export async function readHookInput(stream = process.stdin, maxBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) return {};
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function shouldRememberCapture(status) {
  return status === "sent" || status === "skipped:no-intent";
}

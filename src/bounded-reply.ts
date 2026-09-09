/** Budget the actual UTF-8 tool result, including the compatibility text copy. */
export const REPLY_BYTES = 48 * 1024;
export function jsonReply<T extends Record<string, unknown>>(value: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
}
export const replyBytes = (value: Record<string, unknown>) => Buffer.byteLength(JSON.stringify(jsonReply(value)), "utf8");

/** Offset/count are Unicode code points, never UTF-16 half-surrogates. */
export function textPage(text: string, offset = 0, budget = 12 * 1024) {
  const points = Array.from(text);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > points.length) throw new Error("Invalid response offset.");
  let low = 0, high = Math.min(points.length - offset, budget);
  while (low < high) {
    const n = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(points.slice(offset, offset + n).join(""))) <= budget) low = n;
    else high = n - 1;
  }
  return { text: points.slice(offset, offset + low).join(""), offset,
    nextOffset: offset + low < points.length ? offset + low : null, totalCodePoints: points.length };
}

/**
 * Joins hard-wrapped lines into flowing text, keeping paragraphs and list items.
 * "never expire and\ncan be used" -> "never expire and can be used"
 */
export function unwrapLines(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    const prev = out.at(-1);
    const startsBlock = /^([-*•]|\d+[.)]|#)\s/.test(trimmed);
    if (trimmed && prev && !startsBlock) {
      out[out.length - 1] = `${prev} ${trimmed}`;
    } else {
      out.push(trimmed);
    }
  }
  // Collapse runs of blank lines into one paragraph break.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

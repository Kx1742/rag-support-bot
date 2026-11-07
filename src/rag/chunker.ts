import type { Chunk, SourceDocument } from "../types.ts";

export interface ChunkOptions {
  /** Soft maximum characters per chunk. */
  maxChars?: number;
}

interface Section {
  headingPath: string[];
  lines: string[];
}

/**
 * Splits a Markdown/plain-text document into chunks.
 *
 * Strategy: split on headings first (so each chunk stays on one topic), then split
 * long sections on blank lines. Each chunk is prefixed with its heading path so the
 * embedding knows the context ("Refund Policy > Gift Cards").
 */
export function chunkDocument(doc: SourceDocument, options: ChunkOptions = {}): Chunk[] {
  const maxChars = options.maxChars ?? 800;
  const sections = splitByHeadings(doc.text);
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const body = section.lines.join("\n").trim();
    if (!body) continue;
    const heading = section.headingPath.join(" > ");

    for (const piece of splitLongText(body, maxChars)) {
      chunks.push({
        id: `${doc.docId}#${chunks.length}`,
        docId: doc.docId,
        heading,
        text: heading ? `${heading}\n${piece}` : piece,
      });
    }
  }
  return chunks;
}

function splitByHeadings(text: string): Section[] {
  const sections: Section[] = [];
  const path: string[] = [];
  let current: Section = { headingPath: [], lines: [] };

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!match) {
      current.lines.push(line);
      continue;
    }
    sections.push(current);
    const level = match[1].length;
    path.length = Math.min(path.length, level - 1);
    path[level - 1] = match[2].trim();
    current = { headingPath: path.filter(Boolean), lines: [] };
  }
  sections.push(current);
  return sections;
}

/** Splits on paragraphs, then on lines, then hard-wraps, keeping each piece <= maxChars. */
function splitLongText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const units = text
    .split(/\n\s*\n/)
    .flatMap((p) => (p.length <= maxChars ? [p] : p.split("\n")))
    .flatMap((u) => hardWrap(u, maxChars));

  const pieces: string[] = [];
  let current = "";
  for (const unit of units) {
    const joined = current ? `${current}\n${unit}` : unit;
    if (joined.length > maxChars && current) {
      pieces.push(current.trim());
      current = unit;
    } else {
      current = joined;
    }
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

function hardWrap(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) out.push(text.slice(i, i + maxChars));
  return out;
}

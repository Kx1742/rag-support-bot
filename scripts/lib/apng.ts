// Builds an animated PNG (APNG) from same-sized PNG screenshots, with no dependencies.
// APNG plays in every modern browser and on GitHub, in full colour (unlike GIF's 256).
// Each frame's compressed image data is reused as is: only the chunks around it change.

import { crc32 } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Chunk {
  type: string;
  data: Buffer;
}

function readChunks(png: Buffer): Chunk[] {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error("Not a PNG file");
  const chunks: Chunk[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    chunks.push({ type: png.toString("latin1", at + 4, at + 8), data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return chunks;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(data, crc32(Buffer.from(type, "latin1"))) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** frames: PNG files of the same size and colour type; delaysMs: how long each frame shows. */
export function buildApng(frames: Buffer[], delaysMs: number[], loops = 0): Buffer {
  if (!frames.length) throw new Error("No frames");
  const parsed = frames.map(readChunks);
  const ihdr = parsed[0].find((c) => c.type === "IHDR")!.data;
  for (const [i, chunks] of parsed.entries()) {
    if (!chunks.find((c) => c.type === "IHDR")!.data.equals(ihdr)) throw new Error(`Frame ${i} has a different size or colour type`);
  }
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);

  const out: Buffer[] = [SIGNATURE, chunk("IHDR", ihdr)];
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames.length, 0);
  actl.writeUInt32BE(loops, 4); // 0 = loop forever
  out.push(chunk("acTL", actl));

  let sequence = 0;
  parsed.forEach((chunks, i) => {
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(sequence++, 0);
    fctl.writeUInt32BE(width, 4);
    fctl.writeUInt32BE(height, 8);
    fctl.writeUInt32BE(0, 12); // x offset
    fctl.writeUInt32BE(0, 16); // y offset
    fctl.writeUInt16BE(Math.min(65535, Math.round(delaysMs[i] ?? 2000)), 20);
    fctl.writeUInt16BE(1000, 22); // delay in milliseconds
    fctl.writeUInt8(0, 24); // dispose: none
    fctl.writeUInt8(0, 25); // blend: source (each frame is a full screenshot)
    out.push(chunk("fcTL", fctl));
    for (const c of chunks.filter((c) => c.type === "IDAT")) {
      if (i === 0) {
        out.push(chunk("IDAT", c.data)); // the first frame is also the still image for old viewers
      } else {
        const seq = Buffer.alloc(4);
        seq.writeUInt32BE(sequence++, 0);
        out.push(chunk("fdAT", Buffer.concat([seq, c.data])));
      }
    }
  });
  out.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(out);
}

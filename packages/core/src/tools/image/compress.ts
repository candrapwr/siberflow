/**
 * Image downscale + re-encode for multimodal requests.
 *
 * Rationale: `resolveImageUrl` turns a local file into a base64 data URL that
 * rides in every provider request of the turn (multi-MB for a PNG screenshot).
 * Vision providers internally resize images anyway (OpenAI-compatible ones
 * cap the long side around 1024–2048 px and quantize "detail:low" to 512 px),
 * so sending the original is pure upload waste — the model literally cannot
 * see more than the resized version. Downscaling + JPEG re-encoding to that
 * effective limit keeps what the model would have seen anyway and typically
 * cuts payload to 5–10% of the original.
 *
 * Deliberately conservative:
 *  - data URLs that are already smaller than the threshold pass through
 *    untouched (no pointless decode/encode, no quality loss for small images);
 *  - any decode/encode failure falls back to the input verbatim — compression
 *    must never break image reading;
 *  - http(s) URLs are never touched (the gateway fetches them; not our bytes).
 */
import { PNG } from "pngjs";
import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";

/** Long-side pixel cap after resize. Matches typical vision-side resizing. */
const MAX_SIDE = 1568;
/** Quality for the JPEG re-encode (text/OCR-friendly, still small). */
const JPEG_QUALITY = 80;
/** Only bother compressing data URLs whose base64 exceeds this many bytes. */
const MIN_PAYLOAD_BYTES = 160 * 1024;

/**
 * Compress a `data:image/...;base64,` URL: downscale so the long side is at
 * most MAX_SIDE px, then re-encode as JPEG. Returns the (possibly unchanged)
 * input. Never throws.
 */
export function compressDataUrl(dataUrl: string): string {
  const match = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) return dataUrl; // not an image data URL — leave it alone
  const subtype = match[1]!.toLowerCase();
  const b64 = match[2]!;
  if (b64.length <= MIN_PAYLOAD_BYTES) return dataUrl; // already small enough
  if (subtype === "gif") return dataUrl; // animated/gif semantics: keep verbatim

  let pixels: { width: number; height: number; data: Buffer };
  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64, "base64");
    if (subtype === "png") {
      const png = PNG.sync.read(bytes);
      pixels = { width: png.width, height: png.height, data: png.data };
    } else if (subtype === "jpeg" || subtype === "jpg") {
      const img = decodeJpeg(bytes, { useTint: false, toRGBA: true });
      pixels = {
        width: img.width,
        height: img.height,
        data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength),
      };
    } else {
      return dataUrl; // webp/bmp/etc: no lossless-enough pure-JS decoder here
    }
  } catch {
    return dataUrl; // undecodable — let the provider try the original bytes
  }

  try {
    const resized = resizeRGBA(pixels, MAX_SIDE);
    const out = encodeJpeg(resized, JPEG_QUALITY);
    const candidate = `data:image/jpeg;base64,${out.data.toString("base64")}`;
    // Only win: never let "compression" produce something bigger.
    return candidate.length < dataUrl.length ? candidate : dataUrl;
  } catch {
    return dataUrl;
  }
}

/** Area-ish box downscale (2px average) toward fitMax; never upscales. */
function resizeRGBA(
  img: { width: number; height: number; data: Buffer },
  fitMax: number,
): { width: number; height: number; data: Buffer } {
  const { width, height, data } = img;
  const long = Math.max(width, height);
  if (long <= fitMax) return img;
  const scale = fitMax / long;
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const out = Buffer.alloc(w * h * 4);
  // Source-window average per destination pixel (cheap bilinear-ish box).
  const xRatio = width / w;
  const yRatio = height / h;
  for (let dy = 0; dy < h; dy++) {
    const sy0 = Math.floor(dy * yRatio);
    const sy1 = Math.min(height - 1, Math.floor((dy + 1) * yRatio));
    for (let dx = 0; dx < w; dx++) {
      const sx0 = Math.floor(dx * xRatio);
      const sx1 = Math.min(width - 1, Math.floor((dx + 1) * xRatio));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy <= sy1; sy++) {
        for (let sx = sx0; sx <= sx1; sx++) {
          const i = (sy * width + sx) * 4;
          // premultiply by alpha so transparent edges don't bleed black
          const al = data[i + 3]!;
          r += data[i]! * al;
          g += data[i + 1]! * al;
          b += data[i + 2]! * al;
          a += al;
          n++;
        }
      }
      const o = (dy * w + dx) * 4;
      if (a === 0) {
        out[o] = out[o + 1] = out[o + 2] = 255; // JPEG has no alpha: flatten
        out[o + 3] = 255;
      } else {
        out[o] = Math.min(255, Math.round(r / a));
        out[o + 1] = Math.min(255, Math.round(g / a));
        out[o + 2] = Math.min(255, Math.round(b / a));
        out[o + 3] = Math.min(255, Math.round((a / n) * 1) || 255);
      }
    }
  }
  return { width: w, height: h, data: out };
}

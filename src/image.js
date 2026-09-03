import sharp from 'sharp';

/**
 * 1568px is the largest edge Claude processes at full detail — beyond it the
 * image is resized server-side, so the extra pixels are wasted upload.
 *
 * This was 768px originally, chosen to minimise tokens. That was the wrong
 * trade: telling rice from mashed potato, or kimchi from shredded carrot, is a
 * fine-texture judgement, and at 768px a bowl filling a quarter of the frame is
 * ~200px across with the grain structure gone. The extra resolution roughly
 * doubles the per-photo cost — fractions of a cent — for a large accuracy gain.
 */
export const DEFAULT_MAX_EDGE = 1568;

export async function downscaleToJpeg(buffer, maxEdge = DEFAULT_MAX_EDGE) {
  return sharp(buffer)
    .rotate() // honour EXIF orientation before we discard the metadata
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    // Quality 90, not 80: JPEG artifacts smear exactly the fine texture that
    // separates similar foods. Costs bytes, not tokens.
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * Telegram sends several pre-scaled variants of every photo. Take the smallest
 * one that still meets our target — usually that means the largest available,
 * since Telegram tops out around 1280px for compressed photos.
 *
 * To get past that ceiling, send the picture as a FILE rather than a photo;
 * Telegram then leaves it uncompressed and the bot receives full resolution.
 */
export function pickPhotoSize(sizes, maxEdge = DEFAULT_MAX_EDGE) {
  const byEdge = [...sizes].sort(
    (a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height),
  );
  return byEdge.find((size) => Math.max(size.width, size.height) >= maxEdge) ?? byEdge.at(-1);
}

import sharp from 'sharp';

/**
 * Vision cost scales with pixel count, so photos are shrunk before they ever
 * reach the API. 768px on the longest side is roughly 590 image tokens versus
 * ~1600 for a full-size 1280px Telegram photo.
 */
export const MAX_EDGE = 768;

export async function downscaleToJpeg(buffer) {
  return sharp(buffer)
    .rotate() // honour EXIF orientation before we discard the metadata
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}

/**
 * Telegram already sends several pre-scaled variants of every photo. Picking
 * the smallest one that is still >= MAX_EDGE means we download far fewer bytes
 * (less Railway egress) and hand sharp less work, while still having enough
 * resolution to downscale from cleanly.
 */
export function pickPhotoSize(sizes) {
  const byEdge = [...sizes].sort(
    (a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height),
  );
  return byEdge.find((size) => Math.max(size.width, size.height) >= MAX_EDGE) ?? byEdge.at(-1);
}

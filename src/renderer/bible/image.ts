/**
 * Normalising a picture before it reaches the disk.
 *
 * A phone photograph is four thousand pixels wide and several megabytes; a sheet shows it at
 * sixty-four. Storing the original would put tens of megabytes beside a screenplay to display
 * thumbnails, so every picture is squared, shrunk and re-encoded on the way in — with the
 * browser's own decoder and canvas, so no dependency is involved.
 *
 * WebP because Chromium always writes it, and because pinning one format is what lets the
 * main process refuse everything else.
 */

/** The bytes of a `data:` URI, whatever its media type. */
function decodeBase64(dataUri: string): Uint8Array<ArrayBuffer> {
  const comma = dataUri.indexOf(',');
  if (comma < 0) throw new Error('not a data URI');
  const binary = atob(dataUri.slice(comma + 1));
  // Backed by a plain ArrayBuffer, so it satisfies BlobPart without a cast.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Stored side, in pixels. Twice the largest size the interface shows, for high-density screens. */
const SIDE = 512;

const QUALITY = 0.85;

/**
 * Squares, shrinks and re-encodes a picture, returning a WebP data URI.
 *
 * The crop is centred: a portrait is far more often framed on its subject than on a corner,
 * and cropping beats squashing a face.
 */
export async function normaliseBibleImage(dataUri: string): Promise<string> {
  // Decoded by hand rather than through `fetch(dataUri)`: the renderer's Content-Security-
  // Policy sets `connect-src 'self'`, which does not cover `data:`, so fetching one fails with
  // "Failed to fetch" — a message that says nothing about the real cause.
  const bitmap = await createImageBitmap(new Blob([decodeBase64(dataUri)]));
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(SIDE, SIDE);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('no 2d context');
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      SIDE,
      SIDE,
    );
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: QUALITY });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    // Chunked, because spreading a megabyte of bytes into String.fromCharCode overflows the
    // argument list.
    for (let index = 0; index < bytes.length; index += 8_192) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 8_192));
    }
    return `data:image/webp;base64,${btoa(binary)}`;
  } finally {
    bitmap.close();
  }
}

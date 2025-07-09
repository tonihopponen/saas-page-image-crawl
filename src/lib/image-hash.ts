import axios from 'axios';
import imageHash from 'image-hash';
import crypto from 'crypto';
import { RawImage } from './html-images';

/** Hamming distance between two hex strings */
const ham = (a: string, b: string) =>
  (BigInt('0x' + a) ^ BigInt('0x' + b)).toString(2).replace(/0/g, '').length;

/** Compute pHash; fall back to SHA-256 if the library fails */
async function getHash(url: string): Promise<string> {
  try {
    return await new Promise<string>((res, rej) => {
      imageHash.imageHash(url, 16, true, (err: any, hash: string) => {
        if (err) rej(err);
        else res(hash);
      });
    });
  } catch {
    // pHash failed (SVG, 403, etc.) – fall back to fast SHA-256 of the URL
    return crypto.createHash('sha256').update(url).digest('hex');
  }
}

/**
 * Download each image (GET), compute pHash (or SHA-256), drop near duplicates.
 * - No HEAD check: many CDNs block it.
 * - Distance ≤ 8 treated as duplicate.
 * - Stops after `limit` uniques (50 default).
 */
export async function dedupeImages(
  imgs: RawImage[],
  limit = 50
): Promise<(RawImage & { hash: string })[]> {
  const uniques: { img: RawImage; hash: string }[] = [];

  for (const img of imgs) {
    try {
      // small GET with 10-second timeout
      await axios.get(img.url, { responseType: 'arraybuffer', timeout: 10_000 });

      const canonical = img.url.split('?')[0];   // ignore ?w=1440&fm=webp
      const hash = await getHash(canonical);
      if (uniques.some((u) => ham(u.hash, hash) <= 8)) continue; // near-dup

      uniques.push({ img, hash });
      if (uniques.length >= limit) break;
    } catch (err) {
      /* ignore 403/404/timeout/etc. */
    }
  }

  return uniques.map((u) => ({ ...u.img, hash: u.hash }));
}

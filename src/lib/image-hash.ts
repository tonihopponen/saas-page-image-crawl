import axios from 'axios';
import imageHash from 'image-hash';
import crypto from 'crypto';
import { RawImage } from './html-images';
import probe from 'probe-image-size';

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
 * - Check Content-Length and filter out images under 20kb
 * - Keep images without Content-Length for later dimension checking
 * - Distance ≤ 8 treated as duplicate.
 * - Stops after `limit` uniques (50 default).
 */
export async function dedupeImages(
  imgs: RawImage[],
  limit = 50
): Promise<(RawImage & { hash: string; hasContentLength?: boolean })[]> {
  const uniques: { img: RawImage; hash: string; hasContentLength?: boolean }[] = [];

  for (const img of imgs) {
    try {
      const res = await axios.get<ArrayBuffer>(img.url, {
        responseType: 'arraybuffer',
        timeout: 10_000,
      });

      // Check Content-Length
      const contentLength = res.headers['content-length'];
      if (contentLength) {
        const sizeInBytes = parseInt(contentLength, 10);
        if (sizeInBytes < 20 * 1024) { // Under 20kb
          continue;
        }
      }

      const canonical = img.url.split('?')[0];   // ignore ?w=1440&fm=webp
      const hash = await getHash(canonical);
      if (uniques.some((u) => ham(u.hash, hash) <= 8)) continue; // near-dup

      uniques.push({ 
        img, 
        hash, 
        hasContentLength: !!contentLength 
      });
      if (uniques.length >= limit) break;
    } catch (err) {
      /* ignore 403/404/timeout/etc. */
    }
  }

  return uniques.map((u) => ({ ...u.img, hash: u.hash, hasContentLength: u.hasContentLength }));
}

/**
 * Additional filtering after deduplication:
 * - Remove images with icon/logo in filename
 * - For images without Content-Length: check dimensions (at least 300px in one dimension)
 */
export async function filterImages(
  imgs: (RawImage & { hash: string; hasContentLength?: boolean })[]
): Promise<(RawImage & { hash: string })[]> {
  const filtered: (RawImage & { hash: string })[] = [];

  for (const img of imgs) {
    // Remove images with icon/logo in filename
    const filename = img.url.toLowerCase();
    if (filename.includes('icon') || filename.includes('logo')) {
      continue;
    }

    // For images without Content-Length, check dimensions
    if (!img.hasContentLength) {
      try {
        const res = await axios.get<ArrayBuffer>(img.url, {
          responseType: 'arraybuffer',
          timeout: 10_000,
        });

        const info = await probe(Buffer.from(new Uint8Array(res.data)));
        if (!info || (info.width < 300 && info.height < 300)) {
          continue; // Skip if both dimensions are under 300px
        }
      } catch (err) {
        // If dimension check fails, skip the image
        continue;
      }
    }

    // Keep the image (has Content-Length or passed dimension check)
    filtered.push({ url: img.url, landingPage: img.landingPage, alt: img.alt, context: img.context, hash: img.hash });
  }

  return filtered;
}

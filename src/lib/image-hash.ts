import axios from 'axios';
import imageHash from 'image-hash';
import { RawImage } from './html-images';

type HashResult = { img: RawImage; hash: string };

/** Async wrapper for image-hash (pHash 16×16 → 64-bit hex) */
function computePHash(url: string): Promise<string> {
  return new Promise((res, rej) => {
    imageHash
      .imageHash(url, 16, true, res as any)   // `true` => use phash
      .catch(rej);
  });
}

/** Hamming distance between two hex strings */
function hamming(a: string, b: string): number {
  const n1 = BigInt('0x' + a);
  const n2 = BigInt('0x' + b);
  return (n1 ^ n2).toString(2).replace(/0/g, '').length;
}

/**
 * Download each image, compute pHash, drop near-duplicates.
 * – distance ≤ 8 considered duplicate
 * – returns *same order* as input (keeps first winner)
 */
export async function dedupeImages(imgs: RawImage[]): Promise<(RawImage & { hash: string })[]> {
  const uniques: HashResult[] = [];

  for (const img of imgs) {
    try {
      // quick HEAD check to skip tiny files < 5 kB
      const head = await axios.head(img.url, { timeout: 8000 });
      if ((+head.headers['content-length'] || 0) < 5_000) continue;

      const hash = await computePHash(img.url);
      if (uniques.some((u) => hamming(u.hash, hash) <= 8)) continue; // duplicate

      uniques.push({ img, hash });
      if (uniques.length >= 50) break; // cap for "shallow" mode
    } catch {
      /* ignore failed downloads */
    }
  }

  return uniques.map((u) => ({ ...u.img, hash: u.hash }));
}

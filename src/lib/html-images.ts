import { JSDOM } from 'jsdom';

export interface RawImage {
  url: string;
  landingPage: string;
  alt?: string;
  context?: string;
}

/**
 * Extract image-like URLs from raw HTML.
 * – img[src]
 * – source[srcset]
 * – inline style="background-image:url(..)"
 * Excludes obvious sprites/icons/logos via filename keywords or very small dims later.
 */
export function parseImages(html: string, landingPage: string): RawImage[] {
  if (!html) return [];
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const out: RawImage[] = [];

  /** helper */
  const pushUnique = (url: string, alt?: string, context?: string) => {
    if (!url) return;
    if (!/\.jpe?g$|\.png$|\.webp$/i.test(url)) return; // allowed formats
    if (/(sprite|icon|logo|favicon|avatar|testimonial)/i.test(url)) return;
    out.push({ url, landingPage, alt, context });
  };

  /* <img> */
  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    const alt = img.getAttribute('alt') || undefined;
    // nearest text around the image (simplified)
    const context = img.parentElement?.textContent?.trim().slice(0, 120) || undefined;
    pushUnique(src, alt, context);
  });

  /* <source srcset> – take the first candidate */
  doc.querySelectorAll('source').forEach((s) => {
    const ss = s.getAttribute('srcset') || '';
    const first = ss.split(',')[0]?.trim().split(' ')[0] || '';
    pushUnique(first);
  });

  /* inline background-image URLs */
  doc.querySelectorAll<HTMLElement>('[style*="background-image"]').forEach((el) => {
    const style = el.getAttribute('style')!;
    const m = /background-image:\s*url\(["']?(.*?)["']?\)/i.exec(style);
    if (m?.[1]) pushUnique(m[1]);
  });

  return out;
}

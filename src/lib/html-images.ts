import { JSDOM } from 'jsdom';

/** Returned by the scraper BEFORE dedupe */
export interface RawImage {
  url: string;
  landingPage: string;
  alt?: string;
  context?: string;
}

/**
 * Convert a (possibly relative) path to an absolute URL
 */
function absolutify(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return '';            // ignore malformed urls
  }
}

export function parseImages(html: string, landingPage: string): RawImage[] {
  if (!html) return [];

  const doc = new JSDOM(html).window.document;
  const out: RawImage[] = [];

  /** helper that de-dupes *within this page* */
  const pushed = new Set<string>();
  const push = (raw: string | null, alt?: string, ctx?: string) => {
    if (!raw) return;
    const abs = absolutify(raw, landingPage);
    if (!abs) return;

    // ❌  removed the extension test – HEAD check in dedupeImages will
    //     drop anything that isn't Content-Type: image/*

    if (/(sprite|icon|logo|favicon|avatar|testimonial)/i.test(abs)) return;
    if (pushed.has(abs)) return;

    pushed.add(abs);
    out.push({ url: abs, landingPage, alt, context: ctx });
    console.info('parseImages: pushed', abs);
  };

  /* -------------------- <img> -------------------- */
  doc.querySelectorAll('img').forEach((img) => {
    const alt = img.getAttribute('alt') ?? undefined;
    const ctx = img.parentElement?.textContent?.trim().slice(0, 120) ?? undefined;

    push(img.getAttribute('src'), alt, ctx);           // normal
    push(img.getAttribute('data-src'), alt, ctx);      // lazy-load ①
    push(img.getAttribute('data-original'), alt, ctx); // lazy-load ②
    push(img.getAttribute('data-lazy'), alt, ctx);     // lazy-load ③
  });

  /* -------------------- <source srcset> -------------------- */
  doc.querySelectorAll('source').forEach((s) => {
    // normal srcset
    const ss = s.getAttribute('srcset') ?? s.getAttribute('data-srcset') ?? '';
    const first = ss.split(',')[0].trim().split(' ')[0];
    if (first) push(first);
  });

  /* -------------------- inline CSS -------------------- */
  doc.querySelectorAll<HTMLElement>('[style*="background-image"]').forEach((el) => {
    const style = el.getAttribute('style')!;
    const m = /background-image:\s*url\([\"']?(.*?)[\"']?\)/i.exec(style);
    if (m?.[1]) push(m[1]);
  });

  /* -------------------- <meta property="og:image"> -------------------- */
  const og = doc.querySelector('meta[property="og:image"]')?.getAttribute('content');
  if (og) push(og);

  /* -------------------- <noscript><img …></noscript> -------------------- */
  doc.querySelectorAll('noscript').forEach((n) => {
    const fragment = new JSDOM(n.textContent || '').window.document;
    fragment.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || img.getAttribute('data-src');
      if (src) push(src, img.getAttribute('alt') || undefined);
    });
  });

  return out;
}

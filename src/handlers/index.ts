import { APIGatewayProxyHandlerV2 } from 'aws-lambda';

import { sha256, getObject, putObject } from '../lib/s3';
import { firecrawlScrape } from '../lib/firecrawl';
import { filterHomepageLinks } from '../lib/openai';       // <-- NEW
import { parseImages } from '../lib/html-images';          // <-- NEW
import { dedupeImages } from '../lib/image-hash';          // <-- NEW

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    /* ---------- basic validation ---------- */
    if (!event.body) throw new Error('body missing');
    const { url } = JSON.parse(event.body);
    if (!url) throw new Error('url missing');
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error('url must start with http/https');

    /* ---------- STEP 1 ─ Firecrawl homepage (cached) ---------- */
    const key = `${sha256(url)}/homepage.json`;
    let homepage = await getObject<any>(key);
    if (!homepage) {
      homepage = await firecrawlScrape(url, {
        onlyMainContent: false,
        formats: ['rawHTML', 'links', 'metadata'],
      });
      await putObject(key, homepage);
    }

    /* ---------- STEP 2 ─ GPT-4.1 filters links ---------- */
    const homepageLinks: string[] = homepage.links ?? [];
    const filteredLinks = await filterHomepageLinks(homepageLinks);
    const top4 = filteredLinks.slice(0, 4);

    /* ---------- STEP 3 ─ Firecrawl top-4 pages ---------- */
    const pages = await Promise.all(
      top4.map(async (link) => {
        const page = await firecrawlScrape(link, {
          onlyMainContent: true,
          formats: ['rawHTML'],
        });
        return { link, rawHTML: page.rawHTML ?? '' };
      })
    );

    /* ---------- STEP 4 ─ harvest & dedupe images ---------- */
    let rawImages = parseImages(homepage.rawHTML ?? '', url);     // from homepage
    pages.forEach((p) => {
      rawImages = rawImages.concat(parseImages(p.rawHTML, p.link)); // from each extra page
    });

    const uniqueImages = await dedupeImages(rawImages);           // pHash + 50-limit

    /* ---------- response ---------- */
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_url: url,
        generated_at: new Date().toISOString(),
        kept_links: top4,                    // the four pages we scraped
        image_count: uniqueImages.length,    // up to 50
        images: uniqueImages,                // {url, alt, context, landingPage, hash}
      }),
    };
  } catch (err: any) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: err.message ?? 'unknown error' }),
    };
  }
};

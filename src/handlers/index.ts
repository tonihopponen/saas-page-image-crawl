import { APIGatewayProxyHandlerV2 } from 'aws-lambda';

import { sha256, getObject, putObject } from '../lib/s3';
import { firecrawlScrape } from '../lib/firecrawl';
import { filterHomepageLinks, analyseImages } from '../lib/openai';  // ← added analyseImages
import { parseImages } from '../lib/html-images';
import { dedupeImages } from '../lib/image-hash';

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    /* ---------- validation ---------- */
    if (!event.body) throw new Error('body missing');
    const { url } = JSON.parse(event.body);
    if (!url) throw new Error('url missing');
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error('url must start with http/https');

    /* ---------- STEP 1 – Firecrawl homepage (cached) ---------- */
    const key = `${sha256(url)}/homepage.json`;
    let homepage = await getObject<any>(key);
    if (!homepage) {
      homepage = await firecrawlScrape(url, {
        onlyMainContent: false,
        formats: ['rawHTML', 'links', 'metadata'],
      });
      await putObject(key, homepage);
    }

    /* ---------- STEP 2 – GPT-4.1 link filter ---------- */
    const homepageLinks: string[] = homepage.links ?? [];
    const keptLinks = (await filterHomepageLinks(homepageLinks)).slice(0, 4);

    /* ---------- STEP 3 – Firecrawl top-4 pages ---------- */
    const pages = await Promise.all(
      keptLinks.map(async (link) => {
        const page = await firecrawlScrape(link, {
          onlyMainContent: true,
          formats: ['rawHTML'],
        });
        return { link, rawHTML: page.rawHTML ?? '' };
      })
    );

    /* ---------- STEP 4 – harvest & dedupe images ---------- */
    let imgs = parseImages(homepage.rawHTML ?? '', url);
    pages.forEach((p) => (imgs = imgs.concat(parseImages(p.rawHTML, p.link))));
    const uniqueImgs = await dedupeImages(imgs);          // ≤ 50 items

    /* ---------- STEP 5 – GPT-o4-mini image analysis ---------- */
    const aiData = await analyseImages(uniqueImgs);

    const imagesFinal = uniqueImgs.map((raw) => {
      const ai = aiData.find((a) => a.url === raw.url);
      return {
        url: raw.url,
        alt: ai?.alt ?? raw.alt ?? '',
        landing_page: raw.landingPage,
        type: ai?.type ?? 'unknown',
        confidence: ai?.confidence ?? 0,
        hash: raw.hash,
      };
    });

    /* ---------- FINAL response ---------- */
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_url: url,
        generated_at: new Date().toISOString(),
        images: imagesFinal,
      }),
    };
  } catch (err: any) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: err.message ?? 'unknown error' }),
    };
  }
};


import { APIGatewayProxyHandlerV2 } from 'aws-lambda';

import { sha256, getObject, putObject } from '../lib/s3';
import { firecrawlScrape } from '../lib/firecrawl';
import { filterHomepageLinks, analyseImages } from '../lib/openai';  // ← added analyseImages
import { gptExtractImages } from '../lib/gpt-image-extract';
import { parseImages } from '../lib/html-images';
import { dedupeImages } from '../lib/image-hash';

export const handler: APIGatewayProxyHandlerV2 = async (event: any) => {
  try {
    /* ---------- validation ---------- */
    if (!event.body) throw new Error('body missing');
    console.log('Debug: Raw event.body:', event.body);
    const { url, force_refresh = false } = JSON.parse(event.body);
    if (!url) throw new Error('url missing');
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error('url must start with http/https');
    
    console.log('Debug: force_refresh parameter:', force_refresh);

    // Debug: Check if API keys are set (masked for security)
    const firecrawlKey = process.env.FIRECRAWL_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    console.log('Debug: Firecrawl API key present:', !!firecrawlKey);
    console.log('Debug: OpenAI API key present:', !!openaiKey);
    console.log('Debug: Firecrawl key starts with:', firecrawlKey?.substring(0, 10) + '...');
    console.log('Debug: Deployment version:', process.env.DEPLOYMENT_VERSION);

    /* ---------- STEP 1 – Firecrawl homepage (cached) ---------- */
    console.log('Step 1: Starting Firecrawl scrape for', url);
    const key = `${sha256(url)}/homepage.json`;
    let homepage = await getObject<any>(key);
    
    console.log('Step 1: Cache check - homepage exists:', !!homepage, 'force_refresh:', force_refresh);
    if (!homepage || force_refresh) {
      console.log('Step 1: No cached data or force refresh, scraping fresh');
      homepage = await firecrawlScrape(url, {
        onlyMainContent: false,
        formats: ['links', 'rawHtml'],
        maxAge: 0,            // ⇦ disable read-cache
        storeInCache: false,  // ⇦ don't write either
      });
      // Store with 24h TTL (86400 seconds)
      await putObject(key, homepage, 86400);
    } else {
      console.log('Step 1: Using cached data');
    }

    /* ---------- STEP 2 – GPT-4.1 link filter ---------- */
    const homepageLinks: string[] = homepage.links ?? [];

    // Count how many links Firecrawl gave us
    console.info('Step 1: Firecrawl link count:', homepageLinks.length);          // 🐞

    // Call GPT to keep only product-image pages
    const gptRaw = await filterHomepageLinks(homepageLinks);                      // returns string[]

    // Safeguard: if GPT returned a string instead of JSON, log it
    if (!Array.isArray(gptRaw)) {
      console.warn('Step 2: GPT output was not an array:', gptRaw);               // 🐞
    }

    // Slice to top-1 and log
    const keptLinks = (Array.isArray(gptRaw) ? gptRaw : []).slice(0, 1);
    console.info('Step 2: Kept links:', keptLinks);                               // 🐞

    /* ---------- STEP 3 – Firecrawl top-1 page ---------- */
    console.log('Step 3: Scraping top pages');
    const pages = await Promise.all(
      keptLinks.map(async (link) => {
        const page = await firecrawlScrape(link, {
          onlyMainContent: true,
          formats: ['rawHtml'],
          maxAge: 0,
          storeInCache: false,
        });
        return { link, rawHTML: page.rawHTML ?? '' };
      })
    );
    console.log('Step 3: Scraped', pages.length, 'pages');

    /* ---------- STEP 4 – harvest & dedupe images ---------- */
    let imgs = parseImages(homepage.rawHtml ?? '', url);
    pages.forEach((p) => (imgs = imgs.concat(parseImages(p.rawHTML, p.link))));
    console.info('Step 4a: regex parser found', imgs.length, 'images');

    if (imgs.length === 0) {
      // 🧠 FALLBACK: use GPT-4o-mini to pull URLs from raw HTML
      console.info('Step 4b: invoking GPT fallback');
      const htmlAll =
        (homepage.rawHtml ?? '') + pages.map((p) => p.rawHTML).join('\n');
      const gptUrls = await gptExtractImages(htmlAll, url);     // ← text-only call
      imgs = gptUrls.map((u: string) => ({ url: u, landingPage: url }));
      console.info('Step 4b: GPT returned', gptUrls.length, 'URLs');
    }

    const uniqueImgs = await dedupeImages(imgs);   // HEAD + pHash
    console.info('Step 4c: unique images after dedupe:', uniqueImgs.length);
    const limitedImgs = uniqueImgs.slice(0, 5); // hard cap for test
    console.log('Step 4: Found', limitedImgs.length, 'unique images');

    /* ---------- STEP 5 – GPT-o4-mini analysis (jpeg/png/webp) ---------- */

    // 1 · filter to the formats we care about
    const eligible = uniqueImgs.filter((img) =>
      /\.(jpe?g|png|webp)(\?|$)/i.test(img.url)
    );

    let analysed: Awaited<ReturnType<typeof analyseImages>> = [];

    if (eligible.length) {
      // 2 · send at most five images for enrichment
      const sendToAI = eligible.slice(0, 5);
      console.info(
        `Step 5: sending ${sendToAI.length} of ${eligible.length} eligible images to AI`
      );
      analysed = await analyseImages(sendToAI);
    } else {
      console.warn('Step 5: no jpeg/png/webp images – skipping AI step');
    }

    /* canonicalise → drop query-string + lowercase extension */
    const canon = (u?: string) => (u ? u.split('?')[0] : '');

    /* build lookup by canonical URL */
    const aiByUrl = new Map(
      analysed
        .filter((a) => a.url)              // ⬅ skip entries without url
        .map((a) => [canon(a.url), a])
    );

    const imagesFinal = uniqueImgs.map((raw) => {
      const ai = aiByUrl.get(canon(raw.url));
      return {
        url: raw.url,
        alt: ai?.alt ?? raw.alt ?? '',
        landing_page: raw.landingPage,
        type: ai?.type ?? 'unknown',
        confidence: ai?.confidence ?? 0,
        hash: raw.hash,
      };
    });

    console.log('Final: Returning', imagesFinal.length, 'images');
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
    console.error('Lambda error:', err);
    return {
      statusCode: 400,
      body: JSON.stringify({ 
        error: err.message ?? 'unknown error',
        details: err.response?.data || err.stack || 'No additional details'
      }),
    };
  }
};


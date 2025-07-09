import { APIGatewayProxyHandlerV2 } from 'aws-lambda';

import { sha256, getObject, putObject } from '../lib/s3';
import { firecrawlScrape } from '../lib/firecrawl';
import { filterHomepageLinks, analyseImages } from '../lib/openai';  // ← added analyseImages
import { parseImages } from '../lib/html-images';
import { dedupeImages } from '../lib/image-hash';
import probe from 'probe-image-size';

export const handler: APIGatewayProxyHandlerV2 = async (event: any) => {
  try {
    /* ---------- validation ---------- */
    if (!event.body) throw new Error('body missing');
    const { url } = JSON.parse(event.body);
    if (!url) throw new Error('url missing');
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error('url must start with http/https');

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
    if (!homepage) {
      console.log('Step 1: No cached data, scraping fresh');
      homepage = await firecrawlScrape(url, {
        onlyMainContent: false,
        formats: ['rawHTML', 'links', 'metadata'],
      });
      // Store with 24h TTL (86400 seconds)
      await putObject(key, homepage, 86400);
    } else {
      console.log('Step 1: Using cached data');
    }

    // --- og:image logic: check for og:image in metadata and enqueue if large enough ---
    console.log('Step 1.5: Checking for og:image');
    let ogImage: { url: string; width?: number; height?: number } | undefined;
    if (homepage.metadata && homepage.metadata['og:image']) {
      const ogUrl = homepage.metadata['og:image'];
      try {
        const result = await probe(ogUrl);
        if (result && (result.width >= 600 || result.height >= 600)) {
          ogImage = { url: ogUrl, width: result.width, height: result.height };
          console.log('Step 1.5: Found valid og:image', ogUrl);
        }
      } catch (e) {
        console.log('Step 1.5: og:image check failed:', e);
        // ignore errors, just skip og:image if can't fetch
      }
    }

    /* ---------- STEP 2 – GPT-4.1 link filter ---------- */
    console.log('Step 2: Filtering homepage links');
    const homepageLinks: string[] = homepage.links ?? [];
    const keptLinks = (await filterHomepageLinks(homepageLinks)).slice(0, 4);
    console.log('Step 2: Kept links:', keptLinks);

    /* ---------- STEP 3 – Firecrawl top-4 pages ---------- */
    console.log('Step 3: Scraping top pages');
    const pages = await Promise.all(
      keptLinks.map(async (link) => {
        const page = await firecrawlScrape(link, {
          onlyMainContent: true,
          formats: ['rawHTML'],
        });
        return { link, rawHTML: page.rawHTML ?? '' };
      })
    );
    console.log('Step 3: Scraped', pages.length, 'pages');

    /* ---------- STEP 4 – harvest & dedupe images ---------- */
    console.log('Step 4: Parsing and deduplicating images');
    let imgs = parseImages(homepage.rawHTML ?? '', url);
    // If og:image is valid and not already in imgs, add it
    if (ogImage && !imgs.some(img => img.url === ogImage!.url)) {
      imgs.unshift({ url: ogImage.url, landingPage: url, alt: 'Open Graph image', context: undefined });
    }
    pages.forEach((p) => (imgs = imgs.concat(parseImages(p.rawHTML, p.link))));
    // For testing: limit to 5 unique images (was 50 in production)
    const uniqueImgs = await dedupeImages(imgs.slice(0, 100)); // ≤ 5 items after dedupe
    const limitedImgs = uniqueImgs.slice(0, 5); // hard cap for test
    console.log('Step 4: Found', limitedImgs.length, 'unique images');

    /* ---------- STEP 5 – GPT-o4-mini image analysis ---------- */
    console.log('Step 5: Analyzing images with AI');
    const aiData = await analyseImages(limitedImgs);
    console.log('Step 5: AI analysis complete');

    const imagesFinal = limitedImgs.map((raw) => {
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


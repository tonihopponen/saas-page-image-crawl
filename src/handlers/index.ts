import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import axios from 'axios';

import { sha256, getObject, putObject } from '../lib/s3';
import { firecrawlScrape } from '../lib/firecrawl';
import { filterHomepageLinks, analyseImages } from '../lib/openai';
import { gptExtractImages } from '../lib/gpt-image-extract';
import { parseImages, RawImage } from '../lib/html-images';
import { dedupeImages, filterImages, hasValidFormat, uploadAllImagesToS3, filterS3ImagesByDimension } from '../lib/image-hash';

// Helper function to send webhook notification
async function sendWebhook(webhookUrl: string, data: any, retries = 3): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await axios.post(webhookUrl, data, {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'ImageCrawler-Webhook/1.0'
        }
      });
      console.log('Webhook sent successfully to:', webhookUrl);
      return;
    } catch (error: any) {
      console.error(`Webhook attempt ${i + 1} failed:`, error.message);
      if (i === retries - 1) {
        console.error('All webhook attempts failed for:', webhookUrl);
        throw error;
      }
      // Wait before retry (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
    }
  }
}

export const handler: APIGatewayProxyHandlerV2 = async (event: any) => {
  const startTime = Date.now();
  let webhookUrl: string | undefined;
  let jobId: string | undefined;

  try {
    /* ---------- validation ---------- */
    if (!event.body) throw new Error('body missing');
    console.log('Debug: Raw event.body:', event.body);
    
    const { url, force_refresh = false, webhook_url, job_id } = JSON.parse(event.body);
    if (!url) throw new Error('url missing');
    
    webhookUrl = webhook_url;
    jobId = job_id || `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error('url must start with http/https');
    
    console.log('Debug: Processing job:', jobId);
    console.log('Debug: force_refresh parameter:', force_refresh);
    console.log('Debug: webhook_url provided:', !!webhookUrl);

    // Send started webhook if URL provided
    if (webhookUrl) {
      try {
        await sendWebhook(webhookUrl, {
          job_id: jobId,
          status: 'started',
          source_url: url,
          started_at: new Date().toISOString(),
          message: 'Image crawling process has started'
        });
      } catch (error) {
        console.error('Failed to send started webhook, continuing anyway:', error);
      }
    }

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
    console.info('Step 1: Firecrawl link count:', homepageLinks.length);

    // Call GPT to keep only product-image pages
    const gptRaw = await filterHomepageLinks(homepageLinks);

    // Safeguard: if GPT returned a string instead of JSON, log it
    if (!Array.isArray(gptRaw)) {
      console.warn('Step 2: GPT output was not an array:', gptRaw);
    }

    // Slice to top-1 and log
    const keptLinks = (Array.isArray(gptRaw) ? gptRaw : []).slice(0, 1);
    console.info('Step 2: Kept links:', keptLinks);

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
      const gptUrls = await gptExtractImages(htmlAll, url);
      imgs = gptUrls.map((u: string) => ({ url: u, landingPage: url }));
      console.info('Step 4b: GPT returned', gptUrls.length, 'URLs');
    }

    const uniqueImgs = await dedupeImages(imgs);
    console.info('Step 4c: unique images after dedupe:', uniqueImgs.length);
    console.info('Step 4c: unique image URLs:', uniqueImgs.map(img => img.url));

    // Upload all images to S3 (AVIF to WebP, others as-is)
    const bucket = process.env.S3_BUCKET!;
    const s3Imgs = await uploadAllImagesToS3(uniqueImgs, bucket);
    console.info('Step 4d: images after S3 upload:', s3Imgs.length);
    console.info('Step 4d: S3 image URLs:', s3Imgs.map((img: RawImage & { hash: string }) => img.url));

    // Filter S3 images by dimension (at least one dimension >= 300px), limit to 5
    const filteredImgs = await filterS3ImagesByDimension(s3Imgs);
    console.info('Step 4e: images after dimension filter:', filteredImgs.length);
    console.info('Step 4e: filtered image URLs:', filteredImgs.map((img: RawImage & { hash: string }) => img.url));

    const limitedImgs = filteredImgs.slice(0, 5); // hard cap for test
    console.info('Step 4: limited image URLs:', limitedImgs.map((img: RawImage & { hash: string }) => img.url));
    console.log('Step 4: Found', limitedImgs.length, 'unique images');

    /* ---------- STEP 5 – GPT-o4-mini analysis (jpeg/png/webp) ---------- */

    // 1 · filter to the formats we care about
    const eligible = limitedImgs.filter((img: RawImage & { hash: string }) => {
      // Only allow webp, jpeg, jpg, png
      return /\.(jpe?g|png|webp)(\?|$)/i.test(img.url);
    });

    let analysed: Awaited<ReturnType<typeof analyseImages>> = [];

    if (eligible.length) {
      // 2 · send at most five images for enrichment
      const sendToAI = eligible.slice(0, 5);
      console.info('Step 5: eligible images after format check:', eligible.length);
      console.info('Step 5: sending image URLs:', sendToAI.map((img: RawImage & { hash: string }) => img.url));
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
        .filter((a) => a.url)
        .map((a) => [canon(a.url), a])
    );

    const imagesFinal = limitedImgs.map((raw: RawImage & { hash: string }) => {
      const ai = aiByUrl.get(canon(raw.url));
      return {
        url: raw.url,
        alt: ai?.alt ?? raw.alt ?? '',
        landing_page: raw.landingPage,
        hash: raw.hash,
      };
    });

    console.log('Final: Returning', imagesFinal.length, 'images');

    const result = {
      job_id: jobId,
      status: 'completed',
      source_url: url,
      generated_at: new Date().toISOString(),
      processing_time_ms: Date.now() - startTime,
      images: imagesFinal,
    };

    // Send success webhook
    if (webhookUrl) {
      try {
        await sendWebhook(webhookUrl, result);
      } catch (error) {
        console.error('Failed to send success webhook:', error);
      }
    }

    /* ---------- FINAL response ---------- */
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (err: any) {
    console.error('Lambda error:', err);
    
    const errorResult = {
      job_id: jobId || `error_${Date.now()}`,
      status: 'failed',
      source_url: event.body ? JSON.parse(event.body).url : 'unknown',
      generated_at: new Date().toISOString(),
      processing_time_ms: Date.now() - startTime,
      error: err.message ?? 'unknown error',
      details: err.response?.data || err.stack || 'No additional details'
    };

    // Send error webhook
    if (webhookUrl) {
      try {
        await sendWebhook(webhookUrl, errorResult);
      } catch (webhookError) {
        console.error('Failed to send error webhook:', webhookError);
      }
    }

    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(errorResult),
    };
  }
};


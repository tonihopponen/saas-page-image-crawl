import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { sha256, getObject, putObject } from '../lib/s3';
import { firecrawlScrape } from '../lib/firecrawl';

/**
 * Phase-1 handler:
 *  – Validates URL
 *  – Fetches Firecrawl payload for the homepage
 *  – Caches it in S3 (24 h bucket rule already set)
 *  – Returns the raw Firecrawl JSON to the caller
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) throw new Error('body missing');
    const { url } = JSON.parse(event.body);
    if (!url) throw new Error('url missing');

    // basic sanity check
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error('url must start with http/https');

    const key = `${sha256(url)}/homepage.json`;

    // STEP 1  – Firecrawl scrape (or cached)
    let homepage = await getObject<any>(key);
    if (!homepage) {
      homepage = await firecrawlScrape(url, {
        onlyMainContent: false,
        formats: ['rawHTML', 'links', 'metadata'],
      });
      await putObject(key, homepage);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_url: url,
        scraped_at: new Date().toISOString(),
        homepage,
      }),
    };
  } catch (err: any) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: err.message ?? 'unknown error' }),
    };
  }
};

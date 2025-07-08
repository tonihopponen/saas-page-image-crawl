import axios from 'axios';
import { FirecrawlOptions, FirecrawlResponse } from './types';

/** Minimal wrapper around Firecrawl REST API. */
export async function firecrawlScrape(
  url: string,
  options: FirecrawlOptions
): Promise<FirecrawlResponse> {
  const { data } = await axios.post<FirecrawlResponse>(
    'https://api.firecrawl.dev/v1/scrape',
    { url, options },
    { headers: { 'x-api-key': process.env.FIRECRAWL_API_KEY! } }
  );
  return data;
}

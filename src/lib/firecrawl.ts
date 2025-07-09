import axios from 'axios';
import { FirecrawlOptions, FirecrawlResponse } from './types';

/** Minimal wrapper around Firecrawl REST API. */
export async function firecrawlScrape(
  url: string,
  options: FirecrawlOptions
): Promise<FirecrawlResponse> {
  console.log('Firecrawl: Starting scrape for URL:', url);
  console.log('Firecrawl: Options:', JSON.stringify(options));
  
  const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
  console.log('Firecrawl: API key present:', !!apiKey);
  console.log('Firecrawl: API key length:', apiKey?.length);
  console.log('Firecrawl: API key starts with:', apiKey?.substring(0, 10) + '...');
  console.log('Firecrawl: API key ends with:', '...' + apiKey?.substring(apiKey.length - 4));
  
  if (!apiKey) {
    throw new Error('FIRECRAWL_API_KEY environment variable is not set');
  }
  
  try {
    const { data } = await axios.post<FirecrawlResponse>(
      'https://api.firecrawl.dev/v1/scrape',
      { url, options },
      { 
        headers: { 
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'saas-image-crawl/1.0.0'
        },
        timeout: 30000 // 30 second timeout
      }
    );
    console.log('Firecrawl: Success - Response keys:', Object.keys(data));
    return data;
  } catch (error: any) {
    console.error('Firecrawl: Error details:');
    console.error('  Status:', error.response?.status);
    console.error('  Status Text:', error.response?.statusText);
    console.error('  Response Data:', error.response?.data);
    console.error('  Request URL:', error.config?.url);
    console.error('  Request Method:', error.config?.method);
    console.error('  Request Headers:', {
      'x-api-key': error.config?.headers?.['x-api-key']?.substring(0, 10) + '...',
      'Content-Type': error.config?.headers?.['Content-Type'],
      'User-Agent': error.config?.headers?.['User-Agent']
    });
    console.error('  Request Data:', error.config?.data);
    
    // Additional debugging for common issues
    if (error.response?.status === 401) {
      console.error('Firecrawl: 401 Unauthorized - Possible causes:');
      console.error('  1. API key is invalid or expired');
      console.error('  2. API key has insufficient permissions');
      console.error('  3. Account has reached usage limits');
      console.error('  4. API key format is incorrect');
    }
    
    throw error;
  }
}

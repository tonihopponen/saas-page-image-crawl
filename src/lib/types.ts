export interface FirecrawlOptions {
  onlyMainContent: boolean;
  formats: ('rawHtml' | 'links' | 'metadata')[];
  maxAge?: number;
  storeInCache?: boolean;
}

export interface FirecrawlResponse {
  rawHTML?: string;
  links?: string[];
  metadata?: Record<string, unknown>;
}

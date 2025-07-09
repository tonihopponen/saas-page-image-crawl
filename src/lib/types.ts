export interface FirecrawlOptions {
  onlyMainContent: boolean;
  formats: ('rawHtml' | 'links' | 'metadata')[];
}

export interface FirecrawlResponse {
  rawHTML?: string;
  links?: string[];
  metadata?: Record<string, unknown>;
}

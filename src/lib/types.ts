export interface FirecrawlOptions {
  onlyMainContent: boolean;
  formats: ('rawHTML' | 'links' | 'metadata')[];
}

export interface FirecrawlResponse {
  rawHTML?: string;
  links?: string[];
  metadata?: Record<string, unknown>;
}

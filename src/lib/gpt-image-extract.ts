import { openai } from './openai';

/**
 * Fallback: ask GPT-4o-mini (text-only) to list image URLs in the HTML.
 * Returns absolute URLs; maxImages defaults to 50.
 */
export async function gptExtractImages(
  rawHtml: string,
  baseUrl: string,
  maxImages = 50
): Promise<string[]> {
  const snippet = rawHtml.slice(0, 120_000); // stay under token limits

  const { choices } = await openai.chat.completions.create({
    model: 'gpt-4o-mini',       // ✅ cheapest adequate model
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          `You are an HTML scraper. Extract up to ${maxImages} distinct image URLs ` +
          `that are likely product screenshots or UI mock-ups. ` +
          `Return a JSON array of absolute URLs only — no comments.`,
      },
      { role: 'user', content: `BASE URL: ${baseUrl}` },
      { role: 'user', content: snippet },
    ],
    max_tokens: 600,
  });

  try {
    return JSON.parse(choices[0].message.content ?? '[]');
  } catch {
    return [];
  }
}

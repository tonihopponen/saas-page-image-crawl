import { openai } from './openai';

export async function gptExtractImages(
  html: string,
  baseUrl: string,
  maxImages = 50
): Promise<string[]> {
  const snippet = html.slice(0, 120_000);

  const { choices } = await openai.chat.completions.create({
    model: 'gpt-4o-mini',               // ✅ CHEAP text-only model
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          `You are an HTML scraper. Extract up to ${maxImages} distinct image URLs ` +
          `that are likely product screenshots or UI mock-ups.\n` +
          `Return a JSON array of absolute URLs only — no commentary.`,
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

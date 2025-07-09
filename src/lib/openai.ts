import OpenAI from 'openai';

/**
 * Shared singleton so we don’t create a new TCP connection for every call.
 */
export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/** System prompt taken from the spec. */
const FILTER_SYSTEM_PROMPT = `
You are a SaaS marketing expert.

Your task is to find pages that are most likely to include product images. Product images are defined as visual representations of the SaaS interface, widgets, or embeds as seen by users or in mockups (e.g. dashboards, social media feeds, review widgets, or galleries).

Instructions:
1. Analyse the list of links submitted
2. Remove links that are unlikely to have product images:
   - Legal, company info, login/CTA, social, blog, docs, etc.
3. Prioritise the remaining links in descending likelihood of containing marketing-grade product images.
4. Exclude the homepage itself.
5. Keep only one /compare/ page if many exist.
6. Ignore links that differ only by # fragments.

Answer in *JSON array only*—no extra text.
`;

export async function filterHomepageLinks(links: string[]): Promise<string[]> {
  const { choices } = await openai.chat.completions.create({
    model: 'gpt-4o-2025-05-15',          // GPT-4.1 alias
    temperature: 0.2,
    messages: [
      { role: 'system', content: FILTER_SYSTEM_PROMPT.trim() },
      { role: 'user', content: JSON.stringify(links) },
    ],
  });

  const content = choices[0].message.content;
  try {
    return JSON.parse(content ?? '[]');
  } catch {
    console.error('filterHomepageLinks: cannot parse model output', content);
    return [];                           // fail-safe: nothing gets scraped
  }
}

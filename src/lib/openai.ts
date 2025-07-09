import OpenAI from 'openai';

/* -----------------------------------------------------------
   Shared client (reuse socket)
----------------------------------------------------------- */
export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* -----------------------------------------------------------
   STEP-2  – Link-filter prompt
----------------------------------------------------------- */
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
    model: 'gpt-4.1',          // GPT-4.1 model
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

/* ===========================================================
   STEP-5  – Image analysis with GPT-o4-mini
   -----------------------------------------------------------
   Call in batches of 5 to stay inside token & size limits
=========================================================== */

interface MiniRequest {
  url: string;
  alt?: string;
  context?: string;
}

interface MiniResult {
  url: string;
  alt: string;
  type: 'ui_screenshot' | 'lifestyle';
  confidence: number;
}

export async function analyseImages(
  items: MiniRequest[]
): Promise<MiniResult[]> {
  const batches: MiniRequest[][] = [];
  for (let i = 0; i < items.length; i += 5) batches.push(items.slice(i, i + 5));

  const out: MiniResult[] = [];

  for (const batch of batches) {
    /* Build the multi-modal messages */
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `You are a SaaS conversion-rate expert.

For each image you will receive:
- the image itself
- optional surrounding or alt text

Return a JSON array (same order) with:
  - "alt": concise, marketing-ready alt text
  - "type": "ui_screenshot" or "lifestyle"
  - "confidence": number 0-1 indicating suitability for a product landing page

Respond with JSON only—no commentary.`,
      },
      /* Images as separate content parts */
      ...batch.map<OpenAI.ChatCompletionMessageParam>((img) => ({
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: img.url },
          },
        ],
      })),
      /* Context block */
      {
        role: 'user',
        content: batch
          .map(
            (img, i) =>
              `#${i + 1} context:\n${img.alt ?? ''}\n${img.context ?? ''}`
          )
          .join('\n\n'),
      },
    ];

    /* Call the mini vision model */
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',     // vision-capable lightweight model
      temperature: 0.3,
      messages,
      max_tokens: 10000,
    });

    let raw = resp.choices[0].message.content ?? '[]';

    // 🔄 strip ```json … ``` or ```…``` fences
    raw = raw.replace(/```json|```/gi, '').trim();

    try {
      const json = JSON.parse(raw);
      out.push(...json);
    } catch (err) {
      console.error('analyseImages: JSON parse error', err, raw.slice(0, 100));
      // fallback stub so ordering stays intact
      batch.forEach((b) =>
        out.push({
          url: b.url,
          alt: b.alt ?? '',
          type: 'ui_screenshot',
          confidence: 0,
        })
      );
    }
  }

  return out;
}

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

Input:
- Homepage links

1. Analyse the list of links submitted

2. Remove all links that won't have any product images. Common examples:
- Legal and compliance: privacy policy, terms, GDPR, DPA, security
- Company info: about us, contact, team, press, investor relations
- Account/CTA pages: login, sign up, free trial, book a demo, subscribe, referrals
- Third-party or social links: links to Facebook, LinkedIn, Instagram, YouTube, Twitter, etc.
- Resources and educational content: blog posts, case studies, templates, playbooks, webinars, events
- Developer tools: API docs, integration pages, developer portals
- Localization: alternate language or country-specific versions
- Pricing: plans, pricing pages

3. List the remaining links in a priority order:
- List the links that are most likely to include product images at the top

Important instructions:
- Exclude the homepage (e.g. https://example.com/) from the final output
- Only include pages with marketing-grade product images
- If multiple links start with /compare/, keep only the most general or representative comparison page (e.g. /compare/flockler-alternative)
- Ignore URLs that only differ by # fragment

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
    /* ---------- build single USER prompt ---------- */
    const payload = batch.map((b) => ({
      image_url: b.url,
      context: b.alt || b.context || '',
    }));

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: 'user',
        content: `You are a SaaS marketing expert specialising in website and product images.

Your task is to use vision to analyse the images and write a detailed, marketing-ready alt text.

Input:
- image_url
- context related to each image

Step-by-step task:
1. Use vision to analyse each image thoroughly
2. Read the context provided by the user
3. For each image return in JSON format:
  • "image_url": same URL you received 
  • "alt": detailed, marketing-ready alt text
  • "type": "ui_screenshot" | "lifestyle"
  • "confidence": 0-1 suitability for a product landing page

Respond with JSON only — no markdown.

### INPUT
${JSON.stringify(payload, null, 2)}`,
      },
    ];

    /* ---------- call OpenAI ---------- */
    /* ----- log FULL user prompt in 1-KB slices ----- */
    for (let i = 0; i < (messages[0].content || '').length; i += 1024) {
      console.info(
        `analyseImages: prompt [${i}-${Math.min(i + 1024, (messages[0].content || '').length)}]`,
        (messages[0].content || '').slice(i, i + 1024)
      );
    }

    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages,
      max_tokens: 10000,
      response_format: { type: 'json_object' },
    });

    let raw = '{}';
    try {
      const response = resp as any;
      if (response?.choices?.[0]?.message?.content) {
        raw = response.choices[0].message.content;
      }
    } catch (error) {
      console.error('analyseImages: error accessing response content', error);
    }
    console.info('analyseImages: raw reply →', raw);

    try {
      const json = JSON.parse(raw);
      const arr: { image_url?: string; alt?: string; type?: string; confidence?: number }[] = (json.images ?? []) as any[];
      const batchTyped: MiniRequest[] = batch;

      /* inject real URL if missing */
      if (arr.length === batchTyped.length) {
        arr.forEach((it, i) => {
          if (
            !it ||
            !it.image_url ||
            typeof it.image_url !== 'string' ||
            (typeof it.image_url === 'string' && it.image_url.startsWith('http') === false)
          ) {
            it.image_url = batchTyped[i]?.url ?? '';
          }
        });
      }

      out.push(
        ...arr.map((it) => ({
          url: it.image_url ?? '',
          alt: it.alt ?? '',
          type: (it.type === 'lifestyle' ? 'lifestyle' : 'ui_screenshot') as 'ui_screenshot' | 'lifestyle',
          confidence: it.confidence ?? 0,
        }))
      );
    } catch (err) {
      console.error('analyseImages: JSON parse error', err);
    }
  }
  return out;
}

// fallback to satisfy linter
export default {};

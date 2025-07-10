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
    /* ---------- 1. Build prompt ---------- */
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `You are a SaaS marketing expert specialising in website and product images.

Your task is to analyse each image and return a detailed, marketing-ready description.

Input: For each image you will receive:
• image_url
• context (optional surrounding or alt text)

Return a JSON object with a top-level key "images" whose value is an array.
Each array item must contain:
  • "image_url": the exact image URL you were given
  • "alt": detailed, marketing-ready alt text
  • "type": "ui_screenshot" or "lifestyle"
  • "confidence": 0-1 indicating suitability for a product landing page

Use the exact link you received; do **not** write "#1 context" or similar placeholders.

### Example response
{
  "images": [
    {
      "image_url": "https://example.com/dashboard.png",
      "alt": "Dashboard showing sales analytics & conversion funnel",
      "type": "ui_screenshot",
      "confidence": 0.92
    }
  ]
}

Respond with JSON only — no commentary.`,
      },
    ];

    /* ---------- 2. Attach every image as one multimodal block ---------- */
    batch.forEach((img) =>
      messages.push({
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: img.url },
          },
          {
            type: 'text',
            text: img.alt ?? img.context ?? '',
          },
        ],
      })
    );

    /* ---------- 3. Call OpenAI ---------- */
    console.info('analyseImages: sending batch', batch.map((b) => b.url));

    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages,
      max_tokens: 600,
      response_format: { type: 'json_object' },
    });

    const raw = resp.choices[0].message.content ?? '{}';

    /* log full reply in 1-KB chunks */
    for (let i = 0; i < raw.length; i += 1024) {
      console.info(
        `analyseImages: raw model reply [${i}-${Math.min(i + 1024, raw.length)}]`,
        raw.slice(i, i + 1024)
      );
    }

    /* ---------- 4. Parse & normalise ---------- */
    try {
      const json = JSON.parse(raw);
      const arr: any[] = json.images ?? json.items ?? [];

      if (arr.length === batch.length) {
        arr.forEach((it, idx) => {
          if (
            !it.image_url ||
            typeof it.image_url !== 'string' ||
            it.image_url.startsWith('#')
          ) {
            it.image_url = batch[idx].url;
          }
        });
      }

      out.push(
        ...arr.map((it) => ({
          url: it.image_url,
          alt: it.alt ?? '',
          type: it.type ?? 'ui_screenshot',
          confidence: it.confidence ?? 0,
        }))
      );
    } catch (err) {
      console.error('analyseImages: JSON parse error', err);
      batch.forEach((b) =>
        out.push({
          url: b.url,
          alt: '',
          type: 'ui_screenshot',
          confidence: 0,
        })
      );
    }
  }

  return out;
}

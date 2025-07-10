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
    /* Build messages … (unchanged) */
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `You are a SaaS conversion-rate expert.

For each image you will receive:
• the image itself  
• optional surrounding or alt text

👉 **Return a JSON object with a top-level key "images".  
   That key must hold an array of objects, one per image.**

Each array item **must include exactly these fields**:
  • "url"         – the exact image URL you were given  
  • "alt"         – concise, marketing-ready alt text (≤ 25 words)  
  • "type"        – either "ui_screenshot" or "lifestyle"  
  • "confidence"  – number 0-1 indicating suitability for a product landing page

### Example response

{
  "images": [
    {
      "url": "https://example.com/dashboard.png",
      "alt": "Dashboard showing sales analytics & conversion funnel",
      "type": "ui_screenshot",
      "confidence": 0.92
    },
    {
      "url": "https://example.com/team-collaboration.webp",
      "alt": "Team collaborating on laptops in a modern office",
      "type": "lifestyle",
      "confidence": 0.77
    }
  ]
}

**Respond with JSON only — no extra text, no markdown fences.**`,
      },
      ...batch.map<OpenAI.ChatCompletionMessageParam>((img) => ({
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: img.url },
          },
        ],
      })),
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

    // 🐞 log which URLs we’re sending
    console.info('analyseImages: sending batch', batch.map((b) => b.url));

    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages,
      max_tokens: 400,
      response_format: { type: 'json_object' }, // force valid JSON
    });

    const raw = resp.choices[0].message.content ?? '{}';

    // 🐞 log full reply in 1 KB slices to avoid 256 KB CloudWatch limit
    const CHUNK = 1024;                           // 1 KB per line
    for (let i = 0; i < raw.length; i += CHUNK) {
      console.info(
        `analyseImages: raw model reply [${i}-${Math.min(i + CHUNK, raw.length)}]`,
        raw.slice(i, i + CHUNK)
      );
    }

    try {
      const json = JSON.parse(raw);

      /* Accept either {items:[…]} or {images:[…]} */
      const arr = json.items ?? json.images ?? [];
      out.push(...arr);
    } catch (err) {
      console.error('analyseImages: JSON parse error', err);
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

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
}

export async function analyseImages(
  items: MiniRequest[]
): Promise<MiniResult[]> {
  const out: MiniResult[] = [];

  for (const item of items) {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `You are a SaaS marketing expert. Write a detailed, marketing-ready alt text for this image. Context: ${item.alt || item.context || ""}`,
          },
          {
            type: "image_url",
            image_url: { url: item.url },
          },
        ],
      },
    ] as any;

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 10000,
    });

    const content = resp.choices[0].message.content || "";
    out.push({
      url: item.url,
      alt: content,
    });
  }

  return out;
}

// fallback to satisfy linter
export default {};

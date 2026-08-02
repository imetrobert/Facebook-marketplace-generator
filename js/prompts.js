/**
 * Prompt and response-schema definitions for the two Gemini passes.
 *
 * Pass 1 (intake) looks at the photos and works out what is missing: which
 * extra angles would help the item sell, and which facts only the seller knows.
 * Pass 2 (listing) turns everything into a ready-to-paste Marketplace post.
 */

import { SELLER } from './config.js';

const FB_CONDITIONS = ['New', 'Used - like new', 'Used - good', 'Used - fair'];

const FB_CATEGORIES = [
  'Antiques & Collectibles', 'Appliances', 'Arts & Crafts', 'Auto Parts',
  'Baby & Kids', 'Bags & Luggage', 'Bicycles', 'Books, Films & Music',
  'Cameras', 'Cell Phones & Accessories', 'Computers & Tablets',
  'Electronics', 'Furniture', 'Garden & Outdoor', 'Health & Beauty',
  'Home Decor', 'Home Improvement Supplies', 'Household', 'Jewellery & Watches',
  'Kitchen & Dining', 'Men’s Clothing & Shoes', 'Musical Instruments',
  'Office Supplies', 'Patio & Garden', 'Pet Supplies', 'Sporting Goods',
  'Tools', 'Toys & Games', 'TVs & Video', 'Video Games & Consoles',
  'Women’s Clothing & Shoes', 'Other',
];

const SELLER_CONTEXT = `
SELLER CONTEXT (fixed, applies to every listing):
- Location: ${SELLER.city}, postal code ${SELLER.postalCode} (Montreal area, Quebec, Canada).
- All sales are LOCAL PICKUP ONLY at that address. Never offer shipping or delivery.
- Currency is ${SELLER.currency}. Prices reflect the Montreal / Greater Montreal second-hand market.
- Buyers are a mix of anglophone and francophone. English is primary.`;

const VOICE_RULES = `
VOICE AND FORMATTING RULES (non-negotiable):
- Professional, factual, confident. Write like a careful private seller, not an advertiser.
- ABSOLUTELY NO EMOJIS anywhere in any field. No decorative symbols, no ASCII art.
- No ALL-CAPS words, no exclamation marks, no "!!!", no clickbait, no "MUST GO", no "AMAZING DEAL".
- No invented facts. If a specification is not visible in the photos and was not supplied by the
  seller, leave it out entirely rather than guessing. Never state a size, wattage, model year or
  material you cannot support.
- Never claim the item is new, boxed, or unused unless the evidence or the seller says so.
- Do not mention Facebook, this tool, or that the text was generated.`;

/* ------------------------------------------------------------------ *
 * Pass 1 — intake
 * ------------------------------------------------------------------ */

export const intakeSchema = {
  type: 'object',
  properties: {
    identification: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'Plain-language name of the item.' },
        brand: { type: 'string', description: 'Brand if legible or strongly implied, otherwise empty string.' },
        model: { type: 'string', description: 'Model or product line if determinable, otherwise empty string.' },
        category: { type: 'string', enum: FB_CATEGORIES },
        confidence: { type: 'number', description: 'Confidence in the identification, 0 to 1.' },
        summary: { type: 'string', description: 'One or two sentences on what was observed.' },
      },
      required: ['item', 'brand', 'model', 'category', 'confidence', 'summary'],
    },
    conditionObserved: {
      type: 'array',
      description: 'Specific, concrete condition observations visible in the photos, good and bad.',
      items: { type: 'string' },
    },
    photoRequests: {
      type: 'array',
      description:
        'Additional shots that would materially increase buyer trust or price. Empty array if the existing photos already cover the item well.',
      items: {
        type: 'object',
        properties: {
          angle: { type: 'string', description: 'What to photograph, phrased as an instruction.' },
          why: { type: 'string', description: 'Short reason this shot helps the sale.' },
        },
        required: ['angle', 'why'],
      },
    },
    questions: {
      type: 'array',
      description:
        'Questions only the seller can answer, ordered by how much each one moves the final price. Maximum 6.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          why: { type: 'string', description: 'Short reason this affects price or buyer confidence.' },
          type: { type: 'string', enum: ['text', 'number', 'choice'] },
          options: {
            type: 'array',
            description: 'Choices when type is "choice", otherwise an empty array.',
            items: { type: 'string' },
          },
          placeholder: { type: 'string' },
        },
        required: ['id', 'question', 'why', 'type', 'options', 'placeholder'],
      },
    },
    preliminaryPrice: {
      type: 'object',
      properties: {
        low: { type: 'number' },
        high: { type: 'number' },
        basis: { type: 'string', description: 'One sentence on how the range was reached.' },
      },
      required: ['low', 'high', 'basis'],
    },
  },
  required: ['identification', 'conditionObserved', 'photoRequests', 'questions', 'preliminaryPrice'],
};

export function intakePrompt(userNote) {
  return `You are an expert second-hand reseller who consistently sells items quickly and at the top
of their realistic range on Facebook Marketplace in Montreal, Quebec.

You are being shown photographs of ONE item (or one lot) the seller wants to list. Some images may be
still frames extracted from a video walkaround of the same item; treat all images as the same listing.
${SELLER_CONTEXT}

Your job in this step is NOT to write the listing. It is to close the information gap.

1. Identify the item as precisely as the photos allow. Read any visible labels, model plates, screen
   text, or branding. If you cannot read a model number, say so through a low confidence value rather
   than inventing one.
2. Note concrete condition evidence you can actually see — wear, scuffs, missing parts, included
   accessories, cleanliness, completeness. Be honest about flaws; they belong in the listing.
3. Request additional photos ONLY where a missing shot would genuinely cost the seller money or
   invite time-wasting questions. Typical high-value shots: the model or serial label, a known wear
   point, the item powered on and working, the full item in a room for scale, included accessories,
   and any damage shown honestly and close up. Ask for at most 4. If coverage is already good,
   return an empty list — do not invent busywork.
4. Ask the questions whose answers most change the price or the buyer's confidence. Think about what
   a buyer messages to ask, and what a pricing decision hinges on: age, original purchase price,
   working condition, dimensions, whether accessories or original packaging are included, smoke-free
   or pet-free household, and the reason for selling. Ask at most 6, ordered most valuable first.
   Skip anything already visible in the photos or already told to you by the seller. Use "choice"
   with concrete options where a short answer is enough, "number" for prices, ages and measurements.
   Every choice question automatically gains its own "Unknown" and "Other" buttons in the app, so
   list only concrete answers. Never include an option meaning "unknown", "not sure", "other",
   "N/A" or "prefer not to say" — those are added for you and would appear twice.
5. Give a preliminary Montreal resale price range in ${SELLER.currency} for the item in its apparent
   condition. This is a first pass and will be refined once the seller answers.
${VOICE_RULES}

${userNote ? `The seller added this note about the item:\n"""\n${userNote}\n"""` : 'The seller did not add a note.'}

Return only JSON matching the provided schema.`;
}

/* ------------------------------------------------------------------ *
 * Pass 2 — the listing
 * ------------------------------------------------------------------ */

export const listingSchema = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'The recommended Marketplace title. Maximum 100 characters.',
    },
    titleAlternatives: {
      type: 'array',
      description: 'Two other strong title options with a different angle.',
      items: { type: 'string' },
    },
    titleRationale: { type: 'string', description: 'One sentence on why the chosen title should win clicks.' },
    price: { type: 'number', description: 'The number to type into the Marketplace price field.' },
    pricing: {
      type: 'object',
      properties: {
        listAt: { type: 'number' },
        acceptAbove: { type: 'number', description: 'Lowest offer worth accepting immediately.' },
        walkAwayFloor: { type: 'number', description: 'Do not sell below this.' },
        marketRange: { type: 'string', description: 'The realistic local range, e.g. "$120-$180".' },
        strategy: { type: 'string', description: 'Two or three sentences: why this number, and how to react to lowballs.' },
        repriceAfterDays: { type: 'number', description: 'Days to hold this price before dropping it.' },
        repriceTo: { type: 'number', description: 'The price to drop to if it has not sold by then.' },
      },
      required: ['listAt', 'acceptAbove', 'walkAwayFloor', 'marketRange', 'strategy', 'repriceAfterDays', 'repriceTo'],
    },
    category: { type: 'string', enum: FB_CATEGORIES },
    condition: { type: 'string', enum: FB_CONDITIONS },
    brand: { type: 'string' },
    description: {
      type: 'string',
      description: 'The full Marketplace description, ready to paste. Plain text with line breaks.',
    },
    descriptionFr: {
      type: 'string',
      description: 'A short French summary paragraph, or an empty string if not requested.',
    },
    tags: {
      type: 'array',
      description: 'Up to 20 lowercase search keywords buyers would actually type.',
      items: { type: 'string' },
    },
    photoOrder: {
      type: 'array',
      description: 'How to order the photos when posting, best first, described so the seller can identify each shot.',
      items: { type: 'string' },
    },
    buyerFaq: {
      type: 'array',
      description: 'Likely buyer messages with a suggested reply the seller can send back.',
      items: {
        type: 'object',
        properties: { question: { type: 'string' }, answer: { type: 'string' } },
        required: ['question', 'answer'],
      },
    },
    warnings: {
      type: 'array',
      description: 'Anything the seller should verify before posting, such as unconfirmed specs or a missing measurement. Empty if none.',
      items: { type: 'string' },
    },
  },
  required: [
    'title', 'titleAlternatives', 'titleRationale', 'price', 'pricing', 'category',
    'condition', 'brand', 'description', 'descriptionFr', 'tags', 'photoOrder',
    'buyerFaq', 'warnings',
  ],
};

export function listingPrompt({ userNote, intake, answers, includeFrench }) {
  const answered = answers.filter((a) => !a.unknown && a.answer);
  const unknown = answers.filter((a) => a.unknown);

  const answerBlock = answered.length
    ? answered.map((a) => `- ${a.question}\n  Seller's answer: ${a.answer}`).join('\n')
    : '(The seller did not answer any of the questions.)';

  const unknownBlock = unknown.length
    ? `
THE SELLER WAS ASKED THESE AND DOES NOT KNOW THE ANSWER

${unknown.map((a) => `- ${a.question}`).join('\n')}

Treat these as confirmed gaps, not as questions you can answer yourself. For each one:
- Do not state a value, and do not imply one. Leave the fact out of the specification
  block entirely rather than guessing or writing a range.
- If a buyer is likely to ask, address it once, plainly and without apology, in the
  condition paragraph or the buyer FAQ. For example "the capacity is not printed on the
  card" or "I cannot confirm whether the original box is still in storage". A stated
  unknown costs far less than a wrong claim discovered at pickup.
- Where the unknown fact would materially change what the item is worth, price toward the
  lower half of the realistic range. Buyers discount for uncertainty and so should you.
- Add each one to warnings, phrased as something the seller could still go and check.
`
    : '';

  return `You are an expert second-hand reseller writing a Facebook Marketplace listing that must do two
things: earn the click in a crowded scrolling feed, and pre-answer enough questions that the item sells
without a long back-and-forth.
${SELLER_CONTEXT}

WHAT YOU KNOW ABOUT THIS ITEM

Your own analysis of the photos:
${JSON.stringify(intake, null, 2)}

${userNote ? `The seller's note:\n"""\n${userNote}\n"""` : 'The seller did not add a note.'}

The seller's answers to your questions:
${answerBlock}
${unknownBlock}
The photographs are attached again. Trust the seller's answers over your earlier guesses where they
conflict — the seller is holding the item and you are not.

HOW TO WRITE THE TITLE

The title is the entire click decision. Buyers see a photo, a price and roughly 45 characters before
truncation on mobile, so the first words carry all the weight.
- Maximum 100 characters. Front-load: Brand + Model + the specific noun a buyer would search.
- Add the one differentiating attribute that matters most for this category — size, capacity, colour,
  dimensions, year, material, or "working" for electronics.
- Use the words buyers type, not marketing words. "Sectional sofa" beats "lounge seating solution".
- Include a second common name for the item where one exists, since search matches on the title.
- No emojis, no all-caps, no exclamation marks, no "$" or price in the title, no "OBO", no "must go".
- Do not stuff keywords into a list; it must read as a natural phrase.

HOW TO WRITE THE DESCRIPTION

Plain text, no markdown, no bullet characters other than a simple hyphen, no emojis. Structure it as:
1. One or two opening sentences naming the item precisely and its single strongest selling point.
2. A short specification block, one fact per line as "Label: value" — only facts you can support.
   Include dimensions whenever they are known or were supplied; furniture and appliance buyers
   filter on them and their absence kills listings.
3. A condition paragraph that is specific and honest. Name the flaws plainly and briefly, then move
   on. Stating a small flaw raises trust and cuts down on tyre-kicking; hiding it wastes a trip.
4. What is included, if there are accessories, cables, manuals or original packaging.
5. A closing logistics line: pickup only in ${SELLER.city} (${SELLER.postalCode}), cash preferred,
   and that serious buyers should message with their pickup window. Do not mention shipping.
Keep it scannable — most of it is read on a phone. Aim for 120 to 250 words.

HOW TO PRICE

Price for the Montreal second-hand market in ${SELLER.currency}, in this item's actual condition.
- Anchor on what comparable used units realistically clear for locally, not on retail price and not
  on what optimistic sellers ask.
- Set the list price slightly above your target so there is room to accept a small negotiation, but
  not so high that the listing is filtered out or ignored. Land on a number that reads naturally for
  the category — round numbers for larger items, and avoid fake-precise pricing.
- Give the seller a walk-away floor and the offer level worth accepting on the spot.
- Recommend when to drop the price and to what, if it has not sold.
- Explain the reasoning in a couple of plain sentences.

${includeFrench
    ? `Also write a short French summary paragraph, three or four sentences, covering the item, its condition
and the pickup arrangement. Natural Quebec French, same professional tone, no emojis.`
    : 'Leave the French summary as an empty string.'}
${VOICE_RULES}

Return only JSON matching the provided schema.`;
}

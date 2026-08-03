/**
 * Prompt and response-schema definitions for the two Gemini passes.
 *
 * Pass 1 (intake) looks at the photos and works out what is missing: which
 * extra angles would help the item sell, and which facts only the seller knows.
 * Pass 2 (listing) turns everything into a ready-to-paste Marketplace post.
 */

/* No seller details are hard-coded here any more. Every prompt is built from
   the caller's profile, so a second user gets their own listings rather than a
   variation on someone else's. */

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

/** The fixed facts about whoever is selling, drawn from their profile. */
function sellerContext(p) {
  const lines = [
    `- Location: ${p.location.city}, postal code ${p.location.postalCode} (${p.location.market}, ${p.location.country}).`,
    p.logistics.pickupOnly
      ? '- All sales are LOCAL PICKUP ONLY at that address. Never offer shipping or delivery.'
      : '- Buyers collect at that address. Mention delivery only if the pickup arrangements below allow it.',
    `- Currency is ${p.money.currency}. Prices reflect the ${p.location.market} second-hand market.`,
    `- Payment accepted: ${p.money.payment}. Always state every accepted method, never just one, and`,
    '  never offer a method that is not on that list.',
  ];
  if (p.logistics.notes.trim()) {
    lines.push(`- Pickup arrangements: ${p.logistics.notes.trim()}`);
  }
  if (p.household.smoking && !/prefer not/i.test(p.household.smoking)) {
    lines.push(`- Household: ${p.household.smoking}. State this in the listing; buyers ask.`);
  }
  if (p.household.pets && !/prefer not/i.test(p.household.pets)) {
    lines.push(`- Pets: ${p.household.pets}. State this in the listing; buyers ask.`);
  }
  const second = p.voice.secondLanguage.trim();
  if (second) {
    lines.push(
      `- Buyers are a mix of ${primaryLanguage(p)} and ${second} speakers. ${primaryLanguage(p)} is the primary`,
      `  language: the listing is written in ${primaryLanguage(p)}, with a short ${second} summary underneath.`,
    );
  } else {
    lines.push(`- The listing is written in ${primaryLanguage(p)}.`);
  }
  return `\nSELLER CONTEXT (fixed, applies to every listing):\n${lines.join('\n')}`;
}

/**
 * The language the listing leads with. Profiles saved before this setting
 * existed have no value for it, and those listings were written in English.
 */
const primaryLanguage = (p) => p.voice.primaryLanguage?.trim() || 'English';

/** Tone and formatting, plus whatever standing preferences the seller set. */
function voiceRules(p) {
  const rules = [
    `- Tone: ${p.voice.tone}. Write like a careful private seller, not an advertiser.`,
    p.voice.allowEmojis
      ? '- Emojis are permitted but sparing: at most one or two in the description, never in the title.'
      : '- ABSOLUTELY NO EMOJIS anywhere in any field. No decorative symbols, no ASCII art.',
    '- No ALL-CAPS words, no exclamation marks, no clickbait, no "MUST GO", no "AMAZING DEAL".',
    '- No invented facts. If a specification is not visible in the photos and was not supplied by the',
    '  seller, leave it out entirely rather than guessing. Never state a size, wattage, model year or',
    '  material you cannot support.',
    '- Never claim the item is new, boxed, or unused unless the evidence or the seller says so.',
    '- Do not mention Facebook, this tool, or that the text was generated.',
  ];

  let block = `\nVOICE AND FORMATTING RULES (non-negotiable):\n${rules.join('\n')}`;

  if (p.standingInstructions.trim()) {
    // The seller's own words, quoted rather than folded into the instructions,
    // and explicitly subordinate to the honesty rules above. Those rules are
    // what stop a listing claiming things the photos cannot support, so no
    // stated preference may switch them off.
    block += `

THIS SELLER'S STANDING PREFERENCES, in their own words, applying to every listing they create:
"""
${p.standingInstructions.trim()}
"""
Follow these wherever they are compatible with the rules above. Where they conflict, the rules
above win — in particular, never invent or overstate a fact because a preference asks you to.`;
  }
  return block;
}

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

export function intakePrompt(userNote, profile) {
  return `You are an expert second-hand reseller who consistently sells items quickly and at the top
of their realistic range on Facebook Marketplace in ${profile.location.market}.

You are being shown photographs of ONE item (or one lot) the seller wants to list. Some images may be
still frames extracted from a video walkaround of the same item; treat all images as the same listing.
${sellerContext(profile)}

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
   Skip anything already visible in the photos, already told to you by the seller, or already
   settled by the SELLER CONTEXT above — never ask about pickup, payment, location, or the smoking
   and pet status of the household when those are already stated there. Use "choice"
   with concrete options where a short answer is enough, "number" for prices, ages and measurements.
   Every choice question automatically gains its own "Unknown" and "Other" buttons in the app, so
   list only concrete answers. Never include an option meaning "unknown", "not sure", "other",
   "N/A" or "prefer not to say" — those are added for you and would appear twice.
5. Give a preliminary resale price range in ${profile.money.currency}, for the ${profile.location.market}
   market, for the item in its apparent condition. This is a first pass and will be refined once the
   seller answers.
${voiceRules(profile)}

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
      description:
        "The full Marketplace description in the seller's primary language, ready to paste. Plain text with line breaks.",
    },
    descriptionSecondary: {
      type: 'string',
      description:
        "A short summary paragraph in the seller's second language, or an empty string if none was requested.",
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
    'condition', 'brand', 'description', 'descriptionSecondary', 'tags', 'photoOrder',
    'buyerFaq', 'warnings',
  ],
};

export function listingPrompt({ userNote, intake, answers, profile }) {
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
${sellerContext(profile)}

WHAT YOU KNOW ABOUT THIS ITEM

Your own analysis of the photos:
${JSON.stringify(intake, null, 2)}

${userNote ? `The seller's note:\n"""\n${userNote}\n"""` : 'The seller did not add a note.'}

The seller's answers to your questions:
${answerBlock}
${unknownBlock}
The photographs are attached again. Trust the seller's answers over your earlier guesses where they
conflict — the seller is holding the item and you are not.

WHICH LANGUAGE EACH FIELD IS IN

Everything a buyer reads is written in ${primaryLanguage(profile)} — the title, the description, the
search tags, and the buyer FAQ, both the messages and the suggested replies. Write it the way a
seller near ${profile.location.city} writes that language, using the words buyers there actually
type, rather than translating an English draft. The seller's note and answers above may be in
another language; that does not change the language of the listing.

Two exceptions:
- The category and condition values must be copied exactly from the lists in the schema. They are
  Facebook's own field values and must stay in English, spelling included, or they will not match
  the form the seller is pasting into.
- The pricing strategy, market range wording, photo order, title rationale and warnings are notes
  for the seller rather than for buyers. Write those in English, which is the language of the app
  showing them.

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
5. A closing logistics line: collection in ${profile.location.city} (${profile.location.postalCode}),
   payment by ${profile.money.payment}, and that serious buyers should message with their pickup
   window. State every payment method every time, even if the item is inexpensive.${profile.logistics.pickupOnly
     ? ' Do not mention shipping or delivery.'
     : ''} Do not offer any payment method not listed above.
Keep it scannable — most of it is read on a phone. Aim for 120 to 250 words.

HOW TO PRICE

Price for the ${profile.location.market} second-hand market in ${profile.money.currency}, in this
item's actual condition.
- Anchor on what comparable used units realistically clear for in ${profile.location.market}, not on
  retail price and not on what optimistic sellers ask.
- Set the list price slightly above your target so there is room to accept a small negotiation, but
  not so high that the listing is filtered out or ignored. Land on a number that reads naturally for
  the category — round numbers for larger items, and avoid fake-precise pricing.
- Give the seller a walk-away floor and the offer level worth accepting on the spot.
- Recommend when to drop the price and to what, if it has not sold.
- Explain the reasoning in a couple of plain sentences.

${profile.voice.secondLanguage.trim()
    ? `THE SECOND-LANGUAGE SUMMARY

Also write a short summary paragraph in ${profile.voice.secondLanguage.trim()}, three or four
sentences, covering the item, its condition, the collection arrangement and the accepted payment
methods (${profile.money.payment}). Natural and idiomatic, as that language is actually spoken by
buyers near ${profile.location.city} — not a word-for-word translation, and in the same tone as the
main description. It is a summary and not a second listing: keep it clearly shorter than the
description above it, which is what the listing leads with. Do not add a line announcing that a
translation follows; the app adds that itself and a second one would read as a mistake.

A few of the search tags may be the ${profile.voice.secondLanguage.trim()} words for the item, since
those buyers search in their own language, but most of them stay in ${primaryLanguage(profile)}.`
    : 'Leave the second-language summary as an empty string.'}
${voiceRules(profile)}

Return only JSON matching the provided schema.`;
}

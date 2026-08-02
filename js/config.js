/**
 * Site configuration.
 *
 * Everything in this file is safe to commit to a public repository.
 * The Supabase anon key is a publishable key — it is designed to ship in
 * browser code and is protected by your Row Level Security policies.
 *
 * Your Gemini API key is NOT here and must never be added here. It is entered
 * in the app's Settings panel and stored only in your own browser.
 */

export const SUPABASE = {
  // From your existing Supabase project: Settings -> API -> Project URL
  url: '',
  // From your existing Supabase project: Settings -> API -> Project API keys -> anon / public
  anonKey: '',
};

/** Seller defaults applied to every listing. */
export const SELLER = {
  postalCode: 'H4V 2L5',
  city: 'Côte Saint-Luc, QC',
  pickupOnly: true,
  currency: 'CAD',
};

/**
 * Gemini models. gemini-2.5-flash has a generous free tier and handles vision.
 * gemini-2.5-flash-lite is cheaper/faster and used for the lightweight
 * intake pass where deep reasoning matters less.
 */
export const MODELS = {
  intake: 'gemini-2.5-flash',
  listing: 'gemini-2.5-flash',
  fallback: 'gemini-2.0-flash',
};

/** Image handling limits — keeps requests comfortably inside Gemini's caps. */
export const MEDIA = {
  maxEdgePx: 1152,
  jpegQuality: 0.82,
  maxImages: 12,
  videoFrames: 5,
};

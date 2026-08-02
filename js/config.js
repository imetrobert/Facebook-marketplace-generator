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
  // "AIWithRobert invoices" project — the same one the invoices tool uses, so
  // the same email and password signs you in here.
  url: 'https://ipnajvgwtjrlecbqfwrh.supabase.co',
  // Project Settings -> API -> Publishable key (older projects call this the
  // anon / public key). Never put the service_role or secret key here.
  anonKey: 'sb_publishable_oPa7fZdSTeXKuCwpOF338Q_PcXS57go',
};

/** Seller defaults applied to every listing. */
export const SELLER = {
  postalCode: 'H4V 2L5',
  city: 'Côte Saint-Luc, QC',
  pickupOnly: true,
  currency: 'CAD',
  /** Stated in every description so buyers arrive knowing how to pay. */
  payment: 'cash or Interac e-Transfer',
};

/**
 * Prepended to the description when a French summary is included, so a
 * francophone buyer sees there is French further down before reading past the
 * English. Added by the app rather than the model, so it is always present and
 * always worded the same.
 */
export const FRENCH_NOTICE = '(Description en français ci-dessous)';

/**
 * Model selection.
 *
 * Model names are NOT hard-coded. Google retires them faster than this file
 * would be updated — a pinned name eventually fails with "no longer available
 * to new users". Instead the app asks your key which models it can actually
 * use and ranks them with the weights below, so it keeps working as new
 * versions land.
 *
 * Pick a specific model any time in Settings; that choice overrides all of this.
 */
export const MODEL_PREFERENCES = {
  /**
   * Relative desirability of each family. "flash" wins by default because it
   * carries the most generous free tier while still handling vision well.
   * Raise "pro" above it if you would rather spend quota on quality.
   */
  tiers: { flash: 3, pro: 2, 'flash-lite': 1 },
  /** Prefer generally-available models over preview and experimental ones. */
  preferStable: true,
  /** Re-check the available model list this often. */
  cacheHours: 24,
};

/** Image handling limits — keeps requests comfortably inside Gemini's caps. */
export const MEDIA = {
  maxEdgePx: 1152,
  jpegQuality: 0.82,
  maxImages: 12,
  videoFrames: 5,
};

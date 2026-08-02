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

/*
 * Seller details — location, payment, tone, standing preferences — are no
 * longer here. They belong to the person, not the deployment, so they live in
 * js/profile.js and are edited in the app's Profile screen. This file is only
 * for things that are true of the whole site.
 */

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

/**
 * Site configuration.
 *
 * Everything in this file is safe to commit to a public repository.
 * The Supabase anon key is a publishable key — it is designed to ship in
 * browser code and is protected by your Row Level Security policies.
 *
 * The Gemini API key is NOT here and must never be added here. It is a secret
 * on the Supabase project, reachable only by the `generate` Edge Function —
 * nothing in this repository or in any browser ever sees it.
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
 * Who to ask for help. Shown to anyone the app has to turn away — no grant for
 * this app, or no runs left for the day — so they reach a person rather than a
 * dead end.
 */
export const ADMINISTRATOR = 'Robert Simon';

/**
 * Which app this deployment is.
 *
 * Supabase Auth is per-project, not per-app: every site pointing at the same
 * project shares one set of users. Access is therefore granted per app, in the
 * project's `app_access` table, and this id is how a grant finds this app.
 *
 * Inviting a seller is a row in that table, not an edit to this file — nothing
 * here needs changing to add or remove someone.
 *
 * This is not merely a guard against accidents. The same grant is enforced by
 * row level security on `profiles` (see supabase/profiles.sql), so an account
 * without it cannot read or write seller data even if it bypasses the browser
 * check. The check here exists to show a clear message rather than a broken
 * screen.
 */
export const APP = {
  id: 'fb-marketplace',
};

/**
 * Invite-only sign-up.
 *
 * `codeHash` is the SHA-256 of your invite code, not the code itself, so the
 * repository never carries something that lets a reader in. Generate one in
 * Settings -> Make an invite link, paste it here, and push.
 *
 * Leave it empty to turn sign-up off entirely.
 *
 * Treat this as convenience, not security: the check runs in the browser, so a
 * determined person could skip it. The switch that actually controls the door
 * is "Allow new users to sign up" in Supabase, under Authentication ->
 * Sign In / Providers -> Email. Turn it on to invite someone, off afterwards.
 */
export const INVITES = {
  codeHash: '',
};

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

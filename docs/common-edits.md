# Common edits (recipes) — read this instead of exploring

After any change to `js/`: `npm test` (CI runs it too: Actions → Checks). Pages redeploys on every push to `main`.
Function changes (`supabase/functions/generate/`) are NOT automatic: Actions → Deploy Supabase function → Run workflow.

## Change how listings are written (title, description, pricing method)
Edit `js/prompts.js`: `listingPrompt()` (wording and rules), `listingSchema` (response fields), `intakePrompt()` / `intakeSchema`
(the questions asked after the photos), `FB_CATEGORIES` / `FB_CONDITIONS` (must match Facebook's own values, keep them in English).
Open `docs/code-map.md` for line numbers. Run `npm test` (flow, questions and guided tests read the prompts).

## Change a seller's location, tone, payment, languages
No code: in the app, Profile. Defaults for a brand-new account are `DEFAULT_PROFILE` in `js/profile.js`.

## A Gemini model was retired or generation fails with "no longer available"
Models are discovered from the key, not hard-coded. If a retired name keeps being picked, add it to the `RETIRED` pattern in
`js/gemini.js` (above `rankModels`). Family preference (flash-lite first, then flash, then pro) is `MODEL_PREFERENCES.tiers` in
`js/config.js`. A seller can also pick a model in Settings. Then `npm test` (tests/models.test.mjs asserts the ranking).

## Daily run limit per person
It is data, not code: table `app_run_limits` (see `supabase/usage.sql`), one row per person per app; edit in the Supabase SQL editor.
The Edge Function counts a run only on success.

## Add or remove a person
Insert or delete their row in `app_access` with app `fb-marketplace` (or use access.imetrobert.com). Invite-code settings: `INVITES` in `js/config.js`
(store the SHA-256 hash only).

## Replace the Gemini key
RUNBOOK.md, "Generate fails". The key lives only in the Edge Function secrets; never in `js/`.

## Wording or layout of the page
`index.html` (text and markup) and `css/styles.css`. The layout test checks the phone view down to 320px (`tests/layout.test.mjs`).

## New Supabase table
Migration in `supabase/` with explicit Data API grants in the SAME file (copy `supabase/usage.sql`), access through
`has_app_access('fb-marketplace')`. Run it by hand in the Supabase SQL editor before deploying. A test fails if a secret key appears in the client.

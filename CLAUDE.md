# Facebook Marketplace Generator — read this first, it is the map

Photos → finished Marketplace listing, at fbmarket.imetrobert.com. Plain static site
(no build step) on GitHub Pages; Supabase auth and `profiles` table (shared project);
a Supabase Edge Function (`generate`) holds the Gemini key and calls the model.
Maintenance steps: `RUNBOOK.md`. Full detail: `README.md` (Setup, How it works, Layout,
Changing the output, Tests) — read only the section needed.

## Rules (non-negotiable)
- No secret or service_role key in `js/config.js` or anywhere in the client; a test
  asserts it (`tests/auth.test.mjs`). The Supabase anon/publishable key is the only key
  that belongs in the browser.
- The Gemini key lives only in the Edge Function environment.
- New Supabase tables: explicit Data API grants in the same migration; access via
  `has_app_access('fb-marketplace')`.
- Run `npm test` after any change to `js/` (Playwright; needs `npx playwright install`
  once). Do not commit failing tests.
- Free tier only; do not add paid APIs.

## Where things are
- `index.html` markup · `css/styles.css` all styling
- `js/prompts.js` listing rules and response schemas (tune wording here)
- `js/profile.js` seller profile schema/defaults · `js/app.js` flow and rendering
- `js/gemini.js` model discovery, ranking, retries · `js/media.js` image/video frames
- `js/auth.js` Supabase auth via fetch · `js/config.js` deployment config
- `supabase/functions/generate/index.ts` Edge Function; `supabase/*.sql` tables
- Workflows: `pages.yml` (deploys on push to main), `deploy-function.yml` (manual:
  deploys the Edge Function)
- Tests: `tests/*.test.mjs`, harness in `tests/harness.mjs`

## Cheap-change guide
- Listing wording/pricing rules: edit `js/prompts.js`, commit to main (Pages redeploys).
- Seller details (location, tone, payment): done in the app under Profile, no code.
- Copy/text: edit `index.html`.
- Function changes (`supabase/functions/generate`): commit, then Actions → Deploy
  Supabase function → Run workflow (it is NOT automatic).

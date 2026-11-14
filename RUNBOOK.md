# Runbook — Marketplace Generator (phone-friendly)

## Site not updating
Actions → **Deploy to GitHub Pages** → latest run; Re-run if red. Settings → Pages →
Source must be **GitHub Actions**.

## "Generate" fails or returns errors
1. Gemini key/quota: the key lives in the Supabase Edge Function secrets
   (`GEMINI_API_KEY`). Replace it in Supabase Dashboard → Edge Functions → Secrets, or
   put the new value in this repo's `GEMINI_API_KEY` secret and run Actions →
   **Deploy Supabase function** with "Also update GEMINI_API_KEY" ticked.
2. Function out of date after a code change: run **Deploy Supabase function**.
3. Free-tier quota exhausted for the day: try again tomorrow; the app falls back between
   models automatically (`js/gemini.js`).

## Deploy Supabase function needs
Repo secret `SUPABASE_ACCESS_TOKEN` (a Supabase personal access token; project ref is
public and set in the workflow) and optionally `GEMINI_API_KEY`. The Supabase token
list may show a token named `github-actions` — that is likely this one; do not delete it
without replacing the secret. To rotate: https://supabase.com/dashboard/account/tokens →
generate a new token → update the repo secret → run Deploy Supabase function once.

## Weekly automatic check
Actions → **Checks** runs the browser tests every Monday and on every push to the app code. A red run means something drifted (often a Gemini model name); open the failing step, then `docs/common-edits.md`.

## Quarterly check (5 minutes)
- Open fbmarket.imetrobert.com, sign in, generate one listing from a photo.
- If it fails, work through "Generate fails" above.

## Retiring this app
Drop the app's tables (`profiles` etc.), delete `app_access` rows where
app='fb-marketplace', delete the Edge Function `generate` and its secrets, remove the DNS
record for fbmarket.imetrobert.com, archive the repo. Follow the pattern in
Supabase-platform-'s `migration/decommission_cartmatch.sql`.

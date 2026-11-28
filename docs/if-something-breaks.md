# If something breaks (read this first, then fix only what it names)

1. **A red check or an email from GitHub:** Actions tab, open the failed run, read the last 20 lines of the red step. "Pages build and deployment" red once: re-run the job (usually a transient GitHub error).
2. **A pull request (for example from Dependabot) has a red "PR build check" or "Checks":** do not merge it; open the red step and fix or close the PR.
3. **"Checks" red (`npm test`):** run the failing test named in the log; a retired Gemini model name or changed library shows up here first. Model ranking lives in `js/gemini.js`.
4. **"Generate" fails:** `RUNBOOK.md` "Generate" fails or returns errors. The Gemini key lives only in the `generate` Edge Function; changing the function needs Actions, Deploy Supabase function (it is not automatic).
5. **Site not updating:** `RUNBOOK.md` "Site not updating" (Pages source must be GitHub Actions).

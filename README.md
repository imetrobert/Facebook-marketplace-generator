# Facebook Marketplace Generator

Take photos of something you want to sell, answer a couple of questions, and get a
finished Facebook Marketplace listing — title, price, category, condition, description
and tags — with a copy button on every field.

Live at **https://fbmarket.imetrobert.com**

- Photos and video both work. Video is sampled into still frames in the browser, so a
  two-minute walkaround does not need uploading.
- After the first look, the app tells you which extra angles are worth shooting and asks
  only the questions that actually change the price.
- Your selling profile — where buyers collect, what payment you take, tone, second
  language, and any standing instructions — is entered once and applied to every listing.
- Professional tone, no emojis, ever. Titles are written for search and for the roughly
  45 characters that survive truncation in the mobile feed.
- Optional second-language summary appended to the description. When included, the
  description opens with a heads-up line in that language so those buyers see it
  without scrolling.

No build step, no backend, no server to pay for. It is a static site; the only network
calls are from your browser to Gemini and to Supabase.

---

## Setup

Steps 1 and 3 are already done. Step 2 is the only thing needed per device.

### 1. Turn on GitHub Pages

1. **Settings → Pages** in this repository.
2. Source: **Deploy from a branch**, branch `main`, folder `/ (root)`.
3. Custom domain: `fbmarket.imetrobert.com`. The `CNAME` file in this repo already
   declares it, so the field should populate on its own.
4. Tick **Enforce HTTPS** once the certificate is issued (it can take a few minutes).

Then add this record at name-services.com, alongside your existing `jobs` and `invoices`
records:

| Type  | Host       | Value                  |
| ----- | ---------- | ---------------------- |
| CNAME | `fbmarket` | `imetrobert.github.io` |

DNS usually propagates within an hour.

### 2. Add your Gemini API key

The key is never stored in this repository. It lives in your browser only.

1. Create a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Open the site, tap **Settings**, paste the key, tap **Test key**, then **Save**.

Do this once per device. On your phone, add the site to your home screen afterwards so
it opens like an app.

The free tier covers normal use comfortably. Each listing costs two requests. If you hit
the per-minute limit the app waits and retries by itself rather than failing.

No model name is hard-coded. Google retires models faster than a pinned name would be
updated — that is what causes "this model is no longer available to new users". Instead
the app asks your key which models it can reach and picks the newest stable Flash one,
re-checking daily. If the model it was using disappears mid-request it re-discovers and
carries on without bothering you. Settings has a dropdown if you want to pin a specific
model, and a **Refresh models** button to re-check on demand.

### 3. Sign in

Already wired up. The site sits behind the **AIWithRobert invoices** Supabase project,
so it takes the same email and password as the invoices tool. The session persists per
device, so you sign in once.

The two values in `js/config.js` are the project URL and its publishable key. Both are
designed to ship in browser code, so committing them is expected and safe. The
service_role / secret key must never go there — a test asserts it has not.

To point at a different project, swap those two values and push. If you ever want
password-reset emails to work, add `https://fbmarket.imetrobert.com` under
**Authentication → URL Configuration → Redirect URLs** in Supabase.

---

## How it works

Three steps, two calls to Gemini.

**Step 1 — Photos.** Images are downscaled to 1152 px and re-encoded as JPEG, and videos
are sampled into five evenly spaced frames. All of it happens on the device, which keeps
requests small and fast on a phone connection.

**Step 2 — Details.** Gemini reports what it can see, asks for the extra shots most
likely to raise the price, and asks up to six questions ordered by how much each one
moves the number. Everything is skippable.

Every multiple-choice question also offers **Unknown** and **Other**. "Other" opens a box
for an answer the model did not think to suggest. "Unknown" is not the same as skipping:
the model is told you were asked and genuinely do not know, so it leaves the fact out
rather than guessing, says plainly what is unconfirmed, prices a little more
conservatively, and adds it to the pre-posting checklist.

**Step 3 — Listing.** The finished post, field by field. Alongside it: a pricing
strategy with a walk-away floor and a reprice date, the order to upload your photos in,
and canned replies to the messages you are about to get.

### Layout

| Path             | What it does                                                     |
| ---------------- | ---------------------------------------------------------------- |
| `index.html`     | Markup for all three steps, the sign-in gate and settings         |
| `js/config.js`   | Deployment config: Supabase credentials, model and media limits   |
| `js/profile.js`  | The seller profile: schema, defaults, storage, currency formatting |
| `js/app.js`      | Flow, rendering, clipboard                                       |
| `js/prompts.js`  | Both prompts and their response schemas — tune the wording here   |
| `js/gemini.js`   | REST client: model discovery, ranking, retries and fallback      |
| `js/media.js`    | Image compression and video frame extraction                     |
| `js/auth.js`     | Supabase auth over plain `fetch`, no third-party script          |
| `css/styles.css` | Everything visual                                                |

### Changing the output

Your location, payment methods, tone and standing instructions are all edited in the
app under **Profile** — nothing there needs a code change. `js/prompts.js` holds the
rules that apply to everyone: the title strategy, the description structure and the
pricing method. `js/profile.js` holds the profile schema and its defaults.

### Adding more sellers later

The profile is a versioned document behind an async `loadProfile` / `saveProfile` pair,
keyed by signed-in account. Today those read and write `localStorage`. Pointing them at a
Supabase `profiles` table, one row per user with row-level security, changes that one
file and nothing else — the prompts already take the profile as an argument and hold no
seller details of their own.

---

## Tests

```bash
npm install
npm test
```

Sixty-four checks across eight suites, driving a real browser against a stubbed Gemini and a
stubbed Supabase: the full photo flow, the video path (including that extracted frames
are genuinely distinct), model discovery and recovery from a retired model, the Unknown and Other answer paths, the bilingual description notice, phone layout down to 320px, profile isolation between accounts, failure
handling for bad keys, rate limits, cancellation and malformed responses, and the auth
gate including session refresh, expiry, and that the shipped config really does gate the site.

`npm run serve` starts the site on `http://localhost:8080` if you want to poke at it.

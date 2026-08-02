# Facebook Marketplace Generator

Take photos of something you want to sell, answer a couple of questions, and get a
finished Facebook Marketplace listing — title, price, category, condition, description
and tags — with a copy button on every field.

Live at **https://fbmarket.imetrobert.com**

- Photos and video both work. Video is sampled into still frames in the browser, so a
  two-minute walkaround does not need uploading.
- After the first look, the app tells you which extra angles are worth shooting and asks
  only the questions that actually change the price.
- Pickup location is fixed to H4V 2L5 and never has to be typed.
- Professional tone, no emojis, ever. Titles are written for search and for the roughly
  45 characters that survive truncation in the mobile feed.
- Optional French summary appended to the description, on by default.

No build step, no backend, no server to pay for. It is a static site; the only network
calls are from your browser to Gemini and to Supabase.

---

## Setup

Three things to do once. Steps 1 and 2 are required; step 3 turns on the login.

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

### 3. Turn on the Supabase login

Until you do this the site is open to anyone with the URL. It is still not much use to a
stranger — every request needs *your* Gemini key, which is only in your browser — but it
is worth locking down.

Open `js/config.js` and fill in the two values from your existing Supabase project
(**Settings → API**):

```js
export const SUPABASE = {
  url: 'https://YOUR-PROJECT.supabase.co',
  anonKey: 'eyJ…',
};
```

Both are publishable values designed to ship in browser code, so committing them is
expected and safe. Commit, push, and the sign-in gate turns itself on.

Sign in with the same email and password you use on your other tools. If you ever
send yourself a password-reset email, add `https://fbmarket.imetrobert.com` to
**Authentication → URL Configuration → Redirect URLs** in Supabase first.

---

## How it works

Three steps, two calls to Gemini.

**Step 1 — Photos.** Images are downscaled to 1152 px and re-encoded as JPEG, and videos
are sampled into five evenly spaced frames. All of it happens on the device, which keeps
requests small and fast on a phone connection.

**Step 2 — Details.** Gemini reports what it can see, asks for the extra shots most
likely to raise the price, and asks up to six questions ordered by how much each one
moves the number. Everything is skippable.

**Step 3 — Listing.** The finished post, field by field. Alongside it: a pricing
strategy with a walk-away floor and a reprice date, the order to upload your photos in,
and canned replies to the messages you are about to get.

### Layout

| Path             | What it does                                                     |
| ---------------- | ---------------------------------------------------------------- |
| `index.html`     | Markup for all three steps, the sign-in gate and settings         |
| `js/config.js`   | The only file you edit — Supabase credentials and seller defaults |
| `js/app.js`      | Flow, rendering, clipboard                                       |
| `js/prompts.js`  | Both prompts and their response schemas — tune the wording here   |
| `js/gemini.js`   | REST client with retries and a fallback model                    |
| `js/media.js`    | Image compression and video frame extraction                     |
| `js/auth.js`     | Supabase auth over plain `fetch`, no third-party script          |
| `css/styles.css` | Everything visual                                                |

### Changing the output

Most tuning lives in `js/prompts.js` — the title rules, the description structure and
the pricing instructions are all plain English in there. Seller defaults such as the
postal code are in `js/config.js`.

---

## Tests

```bash
npm install
npm test
```

Thirty checks across four suites, driving a real browser against a stubbed Gemini and a
stubbed Supabase: the full photo flow, the video path (including that extracted frames
are genuinely distinct), failure handling for bad keys, rate limits, cancellation and
malformed responses, and the auth gate including session refresh and expiry.

`npm run serve` starts the site on `http://localhost:8080` if you want to poke at it.

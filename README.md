# Facebook Marketplace Generator

Take photos of something you want to sell, answer a couple of questions, and get a
finished Facebook Marketplace listing — title, price, category, condition, description
and tags — with a copy button on every field.

Live at **https://fbmarket.imetrobert.com**

- Photos and video both work. Video is sampled into still frames in the browser, so a
  two-minute walkaround does not need uploading.
- After the first look, the app tells you which extra angles are worth shooting and asks
  only the questions that actually change the price.
- Your selling profile — where buyers collect, what payment you take, tone, the language
  your ads are written in, and any standing instructions — is entered once and applied to
  every listing.
- Professional tone, no emojis, ever. Titles are written for search and for the roughly
  45 characters that survive truncation in the mobile feed.
- Pick the primary language of the ad, English or French. The title, description, tags
  and buyer replies are written in it, and it is what buyers read first.
- Optional second-language summary appended to the description. When included, the
  description opens with a heads-up line in that language so those buyers see it
  without scrolling.

No build step. The site itself is static, hosted on GitHub Pages; the only moving part
is one small Supabase Edge Function, which holds the Gemini key so that sellers do not
have to. Every network call from the browser goes to the Supabase project and nowhere
else.

---

## Setup

Steps 1 and 3 are already done. Step 2 is done once for the whole site, not per device
and not per seller.

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

### 2. Deploy the Gemini function

The key is never in this repository and never in a browser. It is a secret on the
Supabase project, and the only thing that can reach it is the `generate` Edge Function
in `supabase/functions/generate/`.

1. Create a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Run the database side once, in **SQL Editor**: `supabase/profiles.sql` first, then
   `supabase/usage.sql` (it adds the run counter and the daily cap).
3. Store the key and deploy:

   ```sh
   supabase secrets set GEMINI_API_KEY=AIza...
   supabase functions deploy generate
   ```

That is the whole setup. Sellers need no Google account, no key, and nothing pasted into
Settings — an invite and a password is all they ever handle.

**Each run spends your quota, not theirs**, which is why there is a cap. Every account
gets 25 runs a day by default; analysing photos is one run and writing the listing is
another, so a finished listing normally costs two. Failed attempts are not charged. The
app shows what is left beside the **Analyse photos** button and in Settings, and explains
itself rather than just failing when the allowance is gone. The day rolls over on
Montreal time, not UTC, so nobody is cut off mid-evening.

Change the allowance without redeploying anything:

```sql
-- everyone on this app
update public.app_run_limits set daily_limit = 40
where app = 'fb-marketplace' and user_id is null;

-- or one seller in particular
insert into public.app_run_limits (app, user_id, daily_limit)
select 'fb-marketplace', id, 100 from auth.users where email = 'seller@example.com'
on conflict (app, user_id) do update set daily_limit = excluded.daily_limit;
```

If Gemini's own per-minute limit is hit, the app waits and retries by itself rather than
failing. Note that the free tier's rate limits are per key, so with one shared key the
sellers now contend with each other rather than each having their own allowance — fine
for a handful of invited sellers, worth knowing before inviting a crowd.

No model name is hard-coded. Google retires models faster than a pinned name would be
updated — that is what causes "this model is no longer available to new users". Instead
the app asks the project's key which models it can reach and picks the newest stable
Flash one, re-checking daily. If the model it was using disappears mid-request it
re-discovers and carries on without bothering you. Settings has a dropdown if you want to
pin a specific model, a **Refresh models** button to re-check on demand, and a **Test
connection** button that checks the whole path — session, grant, key and models — without
spending a run.

### 3. Sign in

Already wired up. The site sits behind the **AIWithRobert invoices** Supabase project,
so it takes the same email and password as the invoices tool. The session persists per
device, so you sign in once.

### 4. Create the profiles table

Run `supabase/profiles.sql` once, in the Supabase dashboard under **SQL Editor**. It
creates one row per user and turns on row-level security so a signed-in user can only
ever read or write their own — the isolation is enforced by the database, not by the
browser. It is safe to run again.

Until the table exists the app still works: profiles fall back to browser storage, and
saving reports that it did not reach your account rather than claiming success.

### Adding another person

**By invite link, no dashboard needed:**

1. Open **Settings → Make an invite link**, type a code, tap **Generate**.
2. Put the hash it gives you into `INVITES.codeHash` in `js/config.js` and push.
3. In Supabase, **Authentication → Sign In / Providers → Email**: turn on *Allow new
   users to sign up*, and turn off *Confirm email* unless you have working email set up.
4. Send them the link. They pick their own username and password and are signed straight
   in. Turn the sign-up switch back off afterwards.
5. **Grant them this app.** Signing up creates an account on the project; it does not
   admit them here. In **SQL Editor**, with the address they registered:

   ```sql
   insert into public.app_access (user_id, app, role)
   select id, 'fb-marketplace', 'member'
   from auth.users where email = 'seller@example.com'
   on conflict (user_id, app) do nothing;
   ```

   Until that row exists the app turns them away and tells them who to ask.

The code check runs in the browser, so treat it as convenience rather than security —
the switch in Supabase is what actually opens and closes the door, and step 5 is what
lets them past it. An account without a grant gets nothing: it cannot read or write a
profile, because the same grant is checked by row-level security.

**Or by hand, if you prefer:**

1. **Authentication → Users → Add user** in Supabase. Set an email and password, and
   tick *Auto Confirm User* so they can sign in immediately.
2. Grant them the app with the `insert into public.app_access` statement above, then
   send them the URL and their password.
3. They sign in and are welcomed straight into the profile screen. Every personal
   field starts blank — no inherited postal code — and the app will not generate a
   listing until the essentials are filled in, so nobody can accidentally publish an
   address that is not theirs. They cannot see anyone else's profile, and nobody can
   see theirs.
4. There is nothing else for them to set up. The Gemini key belongs to the project, not
   to their device, so they never see one. If they run out of runs for the day the app
   says so and names the administrator from `ADMINISTRATOR` in `js/config.js`.

The two values in `js/config.js` are the project URL and its publishable key. Both are
designed to ship in browser code, so committing them is expected and safe. The
service_role / secret key must never go there — a test asserts it has not.

To point at a different project, swap those two values and push.

### One Supabase project is shared by every app that points at it

Supabase Auth is per-project, not per-app. Every site using the same project shares one
set of users, so an account created here can authenticate against any sibling app on
that project. Whether it then sees anything depends on how each app authorises.

That is worth deciding deliberately before inviting anyone:

- **Per-app grants** are how this project answers it. The `app_access` table names which
  user may use which app, and `supabase/profiles.sql` puts that grant *inside* the
  row-level security policies — so an account without it cannot read or write seller
  data even if it never loads this page. To invite someone:

  ```sql
  insert into public.app_access (user_id, app, role)
  select id, 'fb-marketplace', 'member'
  from auth.users where email = 'seller@example.com'
  on conflict (user_id, app) do nothing;
  ```

  Revoking is the same statement as a `delete`. **Neither needs a commit or a deploy** —
  the next page load picks it up. `js/config.js` only carries the app's id
  (`APP.id = 'fb-marketplace'`), which is what a grant matches against.
- **"Allow new users to sign up"** in Supabase is the switch that genuinely opens and
  closes registration, project-wide. Turn it on to invite, off afterwards.
- **A separate project per app** is still the most complete isolation, since a user
  created for this app would not exist in the other project at all. It is no longer the
  *only* real option: with grants enforced in the policies, one project can host several
  apps without their users reaching each other's data.

Nothing enforced in the browser is security — the check in `js/app.js` only exists to
show a clear message instead of an app that cannot load anything. The boundary the
database honours is row-level security, which is where the same grant is checked again.
The `generate` Edge Function checks it a third time before it will spend a Gemini call,
so a revoked account loses its data and the LLM in the same instant, from one row.

### Password resets

The sign-in page offers **I forgot my password**, which asks Supabase to email a reset
link. Clicking it returns to the site and stops on "choose a new password" rather than
going into the app, so a half-finished reset cannot leave the old password working.

Two things have to be set up in Supabase for that email to arrive:

- Add `https://fbmarket.imetrobert.com` under **Authentication → URL Configuration →
  Redirect URLs**, or the link will refuse to come back here.
- Configure **SMTP** under **Project Settings → Authentication**. Supabase's built-in
  sender is rate-limited to a handful of messages an hour and often lands in spam, which
  is fine for the occasional reset and not much else.

With no email configured, the fallback is to set a password for someone directly in
**Authentication → Users**.

---

## How it works

Three steps, two calls to Gemini — which is two runs against the daily allowance.

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

**Guided paste** walks one field at a time, in the order the Marketplace app's own New
listing form asks for them: photos, title, price, category, condition, description,
location, tags, meetup preference. There is no Brand field on that form, so there is no
Brand step. Copy, switch to Facebook, paste, come back — the next field is already waiting,
because copying advances immediately rather than after a timer you would miss while
switching apps. Price shows as a readable amount but copies as the bare number the
field accepts. Location shows the full address but copies only the first part of the
postal code, which is what Marketplace's area search matches. The description copies as
one block including the second-language notice and translation. Empty fields produce no
step, and the closing reminder to tick Door pickup appears only for pickup-only
sellers.

### Layout

| Path             | What it does                                                     |
| ---------------- | ---------------------------------------------------------------- |
| `index.html`     | Markup for all three steps, the sign-in gate and settings         |
| `js/config.js`   | Deployment config: Supabase credentials, model and media limits   |
| `js/profile.js`  | The seller profile: schema, defaults, storage, currency formatting |
| `supabase/`      | SQL to run once in the dashboard                                  |
| `js/app.js`      | Flow, rendering, clipboard                                       |
| `js/prompts.js`  | Both prompts and their response schemas — tune the wording here   |
| `js/gemini.js`   | REST client: model discovery, ranking, retries and fallback      |
| `js/media.js`    | Image compression and video frame extraction                     |
| `js/auth.js`     | Supabase auth over plain `fetch`, no third-party script          |
| `css/styles.css` | Everything visual                                                |

### Changing the output

Your location, payment methods, tone, ad language and standing instructions are all
edited in the app under **Profile** — nothing there needs a code change. The primary
language decides what the listing itself is written in; a second language, if you set
one, only adds a short summary below it. Facebook's own category and condition values
stay in English either way, because they have to match the form you are pasting into,
and the seller-facing notes — pricing strategy, photo order, warnings — stay in the
language of the app. `js/prompts.js` holds the
rules that apply to everyone: the title strategy, the description structure and the
pricing method. `js/profile.js` holds the profile schema and its defaults.

### Where profiles live

The `profiles` table is the source of truth, so settings follow a seller to any device.
Browser storage is kept as a per-account cache: the app opens instantly and still works
offline, and because the cache is written before the upload, a failed save is never
silent data loss — the app says the edit is on this device only.

The profile is one `jsonb` document rather than a column per field. Its shape is
versioned in `js/profile.js` and merged over the defaults on read, so adding a setting
later never needs a database migration.

---

## Tests

```bash
npm install
npm test
```

One hundred and ten checks across eleven suites, driving a real browser against a stubbed
Gemini function and a stubbed Supabase: the full photo flow, the video path (including
that extracted frames are genuinely distinct), model discovery and recovery from a retired
model, the Unknown and Other answer paths, the bilingual description notice, the primary
language of the ad in both directions, phone layout down to 320px, profile isolation
between accounts, the guided paste order and clipboard contents, profile reads and writes
against a stubbed profiles table, the blank-slate experience a new account gets, invite
links, self-serve sign-up, the per-app access grant and its fail-closed behaviour, the
daily run cap — what the seller is shown before, during and after spending their
allowance, and that no Gemini key is ever stored or sent — password reset and recovery,
failure handling for refused requests, rate limits, cancellation and malformed responses,
and the auth gate including session refresh, expiry, and that the shipped config really
does gate the site.

`npm run serve` starts the site on `http://localhost:8080` if you want to poke at it.

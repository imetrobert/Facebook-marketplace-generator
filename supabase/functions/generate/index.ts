/**
 * The only thing that knows the Gemini key.
 *
 * The app used to call Google straight from the browser with a key the seller
 * pasted into Settings. That key sat in localStorage on their device, and every
 * seller had to go and get one. Now the key is a project secret and this
 * function is the only path to it.
 *
 * Every request must clear the same two gates the rest of the app uses:
 *
 *   1. a valid Supabase session, and
 *   2. has_app_access('fb-marketplace') — the same grant that row level
 *      security checks on `profiles`, so revoking a seller takes their LLM
 *      access away at the same moment it takes their data away.
 *
 * Then a third, which is new: a daily run cap, because the quota being spent is
 * the owner's rather than the seller's.
 *
 * Deploy with:
 *   supabase secrets set GEMINI_API_KEY=...
 *   supabase functions deploy generate
 */

const GOOGLE = 'https://generativelanguage.googleapis.com/v1beta/models';
const APP = 'fb-marketplace';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')!;

/**
 * The site is served from a different origin than the project, so preflight has
 * to be answered. `*` is safe here: this function authorises by bearer token,
 * never by cookie, so a hostile page cannot borrow a visitor's session by
 * calling it. Set ALLOWED_ORIGIN to pin it to the real site anyway.
 */
const ORIGIN = Deno.env.get('ALLOWED_ORIGIN') || '*';
/** The quota headers below are useless without this: a browser cannot read a
 *  custom response header across origins unless the server says it may. */
const QUOTA_HEADERS = 'X-Runs-Remaining, X-Runs-Limit, X-Runs-Used';

const CORS = {
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Expose-Headers': QUOTA_HEADERS,
};

/** Quota figures ride back on every reply so the UI never has to ask twice. */
type Quota = { used: number; limit: number; remaining: number };

function reply(status: number, body: unknown, quota?: Quota) {
  const headers: Record<string, string> = {
    ...CORS,
    'Content-Type': 'application/json',
  };
  if (quota) {
    headers['X-Runs-Remaining'] = String(quota.remaining);
    headers['X-Runs-Limit'] = String(quota.limit);
    headers['X-Runs-Used'] = String(quota.used);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/** Shaped like Google's own errors, so the browser reports both the same way. */
const fail = (status: number, message: string, code?: string, quota?: Quota) =>
  reply(status, { error: { message }, code }, quota);

async function rpc(name: string, args: unknown, token: string, key = ANON_KEY) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    throw new Error(`${name} failed (${response.status})`);
  }
  return await response.json();
}

/** Who is calling, according to the project rather than according to them. */
async function whoIs(token: string): Promise<{ id: string } | null> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const user = await response.json();
  return user?.id ? { id: user.id } : null;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (request.method !== 'POST') return fail(405, 'Method not allowed.');

  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return fail(401, 'Sign in again — this request carried no session.');

  const user = await whoIs(token);
  if (!user) return fail(401, 'Your session has expired. Sign in again.');

  // The same grant the database enforces on the seller's own data.
  let granted = false;
  try {
    granted = (await rpc('has_app_access', { app_name: APP }, token)) === true;
  } catch {
    return fail(503, 'Could not check your access. Try again in a moment.');
  }
  if (!granted) {
    return fail(403, 'This account does not have access to this app.');
  }

  let body: { action?: string; model?: string; payload?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail(400, 'Malformed request.');
  }

  const quota = (await rpc('app_quota', { app_name: APP }, token)) as Quota;

  // Cheap enough to be worth its own action: the app asks on entry so it can
  // show the seller what is left before they spend anything.
  if (body.action === 'quota') return reply(200, quota, quota);

  if (body.action === 'listModels') {
    const response = await fetch(`${GOOGLE}?pageSize=1000`, {
      headers: { 'x-goog-api-key': GEMINI_API_KEY },
    });
    return reply(response.status, await response.json(), quota);
  }

  if (body.action !== 'generate') return fail(400, 'Unknown action.');
  if (!body.model || !body.payload) return fail(400, 'Missing model or payload.');

  if (quota.remaining <= 0) {
    // Deliberately not a bare 429: the browser retries those, and no amount of
    // retrying will produce another run today. `code` is what it keys on.
    return fail(
      429,
      `You have used all ${quota.limit} of today's runs. They reset tomorrow morning.`,
      'daily_limit',
      quota,
    );
  }

  const response = await fetch(`${GOOGLE}/${body.model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify(body.payload),
  });
  const result = await response.json().catch(() => ({}));

  // Charged only on success. A retired model, a rate limit from Google, or a
  // request the browser retries costs the seller nothing — they got no listing
  // out of it, so taking a run would be charging for a failure.
  if (!response.ok) return reply(response.status, result, quota);

  let remaining = quota.remaining - 1;
  try {
    remaining = (await rpc('record_app_run', { app_name: APP, who: user.id }, SERVICE_KEY, SERVICE_KEY)) as number;
  } catch {
    // Losing count is not worth failing a request the seller has already paid
    // for in waiting; the reply still carries an estimate.
  }

  return reply(200, result, { ...quota, used: quota.used + 1, remaining });
});

/**
 * Application flow.
 *
 * Step 1  seller adds photos/video and an optional note
 * Step 2  Gemini reports what it sees, asks for better angles, asks the
 *         questions that actually move the price
 * Step 3  the finished listing, field by field, each one tap-to-copy
 */

import { SELLER, MEDIA } from './config.js';
import * as auth from './auth.js';
import * as gemini from './gemini.js';
import { prepareFiles } from './media.js';
import { intakePrompt, intakeSchema, listingPrompt, listingSchema } from './prompts.js';

const $ = (id) => document.getElementById(id);

const FRENCH_STORAGE = 'fbmg.includeFrench';

const state = {
  assets: [],
  userNote: '',
  intake: null,
  answers: [],
  listing: null,
  addedSinceIntake: 0,
  abort: null,
};

/* ── Small helpers ────────────────────────────────────────────── */

const money = (n) =>
  typeof n === 'number' && Number.isFinite(n)
    ? new Intl.NumberFormat('en-CA', { style: 'currency', currency: SELLER.currency, maximumFractionDigits: 0 }).format(n)
    : '—';

function show(el, visible = true) {
  if (el) el.hidden = !visible;
}

function setText(el, text) {
  if (el) el.textContent = text ?? '';
}

let toastTimer;
function toast(message) {
  const el = $('toast');
  setText(el, message);
  show(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => show(el, false), 1800);
}

function showError(message) {
  const el = $('app-error');
  setText(el, message);
  show(el, Boolean(message));
  if (message) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function busy(on, message = 'Working…') {
  setText($('busy-text'), message);
  show($('busy'), on);
}

async function copyText(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    // Clipboard API needs a secure context and can still be refused; a
    // hidden textarea plus execCommand remains the reliable fallback.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand?.('copy');
    ta.remove();
    toast(ok ? label : 'Copy failed — select the text manually');
  }
}

function goToStep(n) {
  for (const step of [1, 2, 3]) show($(`step-${step}`), step === n);
  for (const li of $('steps').children) {
    const value = Number(li.dataset.step);
    li.classList.toggle('active', value === n);
    li.classList.toggle('done', value < n);
  }
  showError('');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ── Step 1: media ────────────────────────────────────────────── */

function renderThumbs() {
  const wrap = $('thumbs');
  wrap.replaceChildren();
  show(wrap, state.assets.length > 0);

  for (const asset of state.assets) {
    const cell = document.createElement('div');
    cell.className = 'thumb';

    const img = document.createElement('img');
    img.src = asset.previewUrl;
    img.alt = asset.name;
    img.loading = 'lazy';
    cell.append(img);

    if (asset.kind === 'video') {
      const badge = document.createElement('span');
      badge.className = 'thumb-badge';
      badge.textContent = 'VIDEO';
      cell.append(badge);
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'thumb-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${asset.name}`);
    remove.addEventListener('click', () => {
      state.assets = state.assets.filter((a) => a.id !== asset.id);
      renderThumbs();
    });
    cell.append(remove);

    wrap.append(cell);
  }

  $('analyze-btn').disabled = state.assets.length === 0;
}

async function handleFiles(fileList) {
  if (!fileList?.length) return;
  showError('');
  const status = $('media-status');
  const errorBox = $('media-errors');
  show(errorBox, false);

  const before = state.assets.length;

  show(status);
  const { assets, errors } = await prepareFiles(fileList, (msg) => setText(status, msg));
  show(status, false);

  const room = Math.max(0, MEDIA.maxImages - state.assets.length);
  const accepted = assets.slice(0, room);
  state.assets.push(...accepted);

  if (assets.length > room) {
    errors.push(`Only ${MEDIA.maxImages} images are sent to keep the request within Gemini's limits; ${assets.length - room} were left out.`);
  }

  if (errors.length) {
    errorBox.replaceChildren(
      ...errors.map((text) => Object.assign(document.createElement('li'), { textContent: text })),
    );
    show(errorBox);
  }

  state.addedSinceIntake += state.assets.length - before;
  renderThumbs();

  // Once intake has run, extra photos are the "better angles" round — tell the
  // seller they landed rather than leaving the tap feeling like a no-op.
  if (state.intake && state.addedSinceIntake > 0) {
    const noun = state.addedSinceIntake === 1 ? 'photo' : 'photos';
    setText($('added-count'), `${state.addedSinceIntake} ${noun} added — they will be used in the listing.`);
    show($('added-count'));
  }
}

/* ── Step 2: intake ───────────────────────────────────────────── */

function renderIntake(intake) {
  const { identification: id, conditionObserved, photoRequests, questions, preliminaryPrice } = intake;

  const name = [id.brand, id.model].filter(Boolean).join(' ') || id.item;
  setText($('intake-title'), name);
  setText(
    $('intake-summary'),
    id.confidence < 0.55
      ? `${id.summary} I am not fully certain what this is, so your answers below matter more than usual.`
      : id.summary,
  );

  const observed = $('observed-list');
  observed.replaceChildren(
    ...(conditionObserved || []).map((text) => Object.assign(document.createElement('li'), { textContent: text })),
  );
  show($('intake-observed'), (conditionObserved || []).length > 0);

  const photoList = $('photo-request-list');
  photoList.replaceChildren(
    ...(photoRequests || []).map((request) => {
      const li = document.createElement('li');
      li.append(Object.assign(document.createElement('strong'), { textContent: request.angle }));
      li.append(Object.assign(document.createElement('span'), { className: 'why', textContent: request.why }));
      return li;
    }),
  );
  show($('intake-photos'), (photoRequests || []).length > 0);
  state.addedSinceIntake = 0;
  show($('added-count'), false);

  renderQuestions(questions || []);

  if (preliminaryPrice && Number.isFinite(preliminaryPrice.low)) {
    setText(
      $('prelim-price'),
      `First estimate: ${money(preliminaryPrice.low)} to ${money(preliminaryPrice.high)}. ${preliminaryPrice.basis}`,
    );
    show($('prelim-price'));
  } else {
    show($('prelim-price'), false);
  }
}

function renderQuestions(questions) {
  const wrap = $('intake-questions');
  wrap.replaceChildren();

  for (const q of questions) {
    const block = document.createElement('div');
    block.className = 'question';
    block.append(Object.assign(document.createElement('div'), { className: 'q', textContent: q.question }));
    if (q.why) block.append(Object.assign(document.createElement('div'), { className: 'why', textContent: q.why }));

    if (q.type === 'choice' && q.options?.length) {
      const choices = document.createElement('div');
      choices.className = 'choices';
      // A hidden input keeps the selected value in one place for readAnswers.
      const hidden = Object.assign(document.createElement('input'), { type: 'hidden' });
      hidden.dataset.answer = q.question;

      for (const option of q.options) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'choice';
        chip.textContent = option;
        chip.addEventListener('click', () => {
          const alreadySelected = chip.classList.contains('selected');
          for (const other of choices.querySelectorAll('.choice')) other.classList.remove('selected');
          chip.classList.toggle('selected', !alreadySelected);
          hidden.value = alreadySelected ? '' : option;
        });
        choices.append(chip);
      }
      block.append(choices, hidden);
    } else {
      const input = document.createElement('input');
      input.type = q.type === 'number' ? 'number' : 'text';
      if (q.type === 'number') input.inputMode = 'decimal';
      input.placeholder = q.placeholder || '';
      input.dataset.answer = q.question;
      block.append(input);
    }
    wrap.append(block);
  }
}

function readAnswers() {
  return Array.from($('intake-questions').querySelectorAll('[data-answer]'))
    .map((el) => ({ question: el.dataset.answer, answer: el.value.trim() }))
    .filter((a) => a.answer !== '');
}

/* ── Step 3: listing output ───────────────────────────────────── */

function outField({ label, value, big = false, hint = '', copyValue }) {
  const box = document.createElement('div');
  box.className = 'out-field';

  const head = document.createElement('div');
  head.className = 'out-head';
  head.append(Object.assign(document.createElement('span'), { className: 'out-label', textContent: label }));

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn btn-sm btn-secondary';
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => copyText(copyValue ?? value, `${label} copied`));
  head.append(copy);

  const body = document.createElement('div');
  body.className = `out-body${big ? ' big' : ''}`;
  body.textContent = value;

  box.append(head, body);
  if (hint) box.append(Object.assign(document.createElement('div'), { className: 'out-hint', textContent: hint }));
  return box;
}

function renderListing(listing) {
  const out = $('listing-output');
  out.replaceChildren();

  /* Title, plus the alternatives as one-tap swaps. */
  const titleField = outField({
    label: 'Title',
    value: listing.title,
    big: true,
    hint: `${listing.title.length}/100 characters. ${listing.titleRationale || ''}`.trim(),
  });
  for (const alt of listing.titleAlternatives || []) {
    const row = document.createElement('div');
    row.className = 'alt-title';
    row.append(Object.assign(document.createElement('span'), { textContent: alt }));
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-sm btn-ghost';
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => copyText(alt, 'Alternative title copied'));
    row.append(copy);
    titleField.append(row);
  }
  out.append(titleField);

  out.append(outField({ label: 'Price', value: money(listing.price), copyValue: String(Math.round(listing.price)) }));

  /* Pricing strategy — read-only guidance, nothing to paste. */
  const pricing = listing.pricing || {};
  const strategy = document.createElement('div');
  strategy.className = 'out-field';
  const head = document.createElement('div');
  head.className = 'out-head';
  head.append(Object.assign(document.createElement('span'), { className: 'out-label', textContent: 'Pricing strategy' }));
  strategy.append(head);

  const grid = document.createElement('div');
  grid.className = 'pricing-grid';
  const cells = [
    ['List at', money(pricing.listAt)],
    ['Accept above', money(pricing.acceptAbove)],
    ['Never below', money(pricing.walkAwayFloor)],
    ['Local range', pricing.marketRange || '—'],
  ];
  if (Number.isFinite(pricing.repriceTo) && Number.isFinite(pricing.repriceAfterDays)) {
    cells.push([`Drop after ${pricing.repriceAfterDays}d`, money(pricing.repriceTo)]);
  }
  for (const [k, v] of cells) {
    const cell = document.createElement('div');
    cell.className = 'price-cell';
    cell.append(
      Object.assign(document.createElement('div'), { className: 'k', textContent: k }),
      Object.assign(document.createElement('div'), { className: 'v', textContent: v }),
    );
    grid.append(cell);
  }
  strategy.append(grid);
  if (pricing.strategy) {
    strategy.append(Object.assign(document.createElement('div'), { className: 'out-hint', textContent: pricing.strategy }));
  }
  out.append(strategy);

  out.append(outField({ label: 'Category', value: listing.category }));
  out.append(outField({ label: 'Condition', value: listing.condition }));
  if (listing.brand) out.append(outField({ label: 'Brand', value: listing.brand }));

  const description = listing.descriptionFr
    ? `${listing.description}\n\n${listing.descriptionFr}`
    : listing.description;
  out.append(outField({ label: 'Description', value: description }));

  out.append(
    outField({
      label: 'Location',
      value: `${SELLER.city} ${SELLER.postalCode}`,
      hint: 'Pickup only. Marketplace asks for this as a city, not a full address.',
      copyValue: SELLER.postalCode,
    }),
  );

  /* Tags */
  if (listing.tags?.length) {
    const box = document.createElement('div');
    box.className = 'out-field';
    const tagHead = document.createElement('div');
    tagHead.className = 'out-head';
    tagHead.append(Object.assign(document.createElement('span'), { className: 'out-label', textContent: 'Search tags' }));
    const copyTags = document.createElement('button');
    copyTags.type = 'button';
    copyTags.className = 'btn btn-sm btn-secondary';
    copyTags.textContent = 'Copy';
    copyTags.addEventListener('click', () => copyText(listing.tags.join(', '), 'Tags copied'));
    tagHead.append(copyTags);

    const list = document.createElement('div');
    list.className = 'tag-list';
    for (const tag of listing.tags) {
      list.append(Object.assign(document.createElement('span'), { className: 'tag', textContent: tag }));
    }
    box.append(tagHead, list);
    out.append(box);
  }

  if (listing.photoOrder?.length) {
    out.append(
      outField({
        label: 'Photo order',
        value: listing.photoOrder.map((p, i) => `${i + 1}. ${p}`).join('\n'),
        hint: 'The first photo does most of the work in the feed.',
      }),
    );
  }

  if (listing.warnings?.length) {
    const warn = document.createElement('p');
    warn.className = 'alert alert-warn';
    warn.textContent = `Check before posting: ${listing.warnings.join(' ')}`;
    out.append(warn);
  }

  if (listing.buyerFaq?.length) {
    const box = document.createElement('div');
    box.className = 'out-field';
    const faqHead = document.createElement('div');
    faqHead.className = 'out-head';
    faqHead.append(Object.assign(document.createElement('span'), { className: 'out-label', textContent: 'Ready replies' }));
    box.append(faqHead);
    for (const item of listing.buyerFaq) {
      const details = document.createElement('details');
      details.className = 'faq';
      details.append(Object.assign(document.createElement('summary'), { textContent: item.question }));
      const answer = document.createElement('div');
      answer.className = 'a';
      answer.textContent = item.answer;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn btn-sm btn-ghost';
      copy.textContent = 'Copy reply';
      copy.addEventListener('click', () => copyText(item.answer, 'Reply copied'));
      answer.append(document.createElement('br'), copy);
      details.append(answer);
      box.append(details);
    }
    out.append(box);
  }

  /* Everything at once, for pasting into notes or a draft. */
  const all = [
    listing.title,
    '',
    `Price: ${money(listing.price)}`,
    `Category: ${listing.category}`,
    `Condition: ${listing.condition}`,
    listing.brand ? `Brand: ${listing.brand}` : '',
    `Location: ${SELLER.city} ${SELLER.postalCode} (pickup only)`,
    '',
    description,
    '',
    listing.tags?.length ? `Tags: ${listing.tags.join(', ')}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');

  const copyAll = document.createElement('button');
  copyAll.type = 'button';
  copyAll.className = 'btn btn-primary';
  copyAll.style.width = '100%';
  copyAll.textContent = 'Copy the whole listing';
  copyAll.addEventListener('click', () => copyText(all, 'Full listing copied'));
  out.append(copyAll);
}

/* ── Gemini runs ──────────────────────────────────────────────── */

function includeFrench() {
  return localStorage.getItem(FRENCH_STORAGE) !== 'off';
}

async function runIntake() {
  if (!state.assets.length) return;
  state.userNote = $('user-note').value.trim();
  state.abort = new AbortController();
  busy(true, 'Looking at your photos…');
  showError('');

  try {
    state.intake = await gemini.generate({
      prompt: intakePrompt(state.userNote),
      assets: state.assets,
      schema: intakeSchema,
      temperature: 0.3,
      signal: state.abort.signal,
      onRetry: (msg) => busy(true, msg),
    });
    renderIntake(state.intake);
    goToStep(2);
  } catch (err) {
    if (err.name !== 'AbortError') showError(err.message);
  } finally {
    busy(false);
    state.abort = null;
  }
}

async function runListing() {
  state.answers = readAnswers();
  state.abort = new AbortController();
  busy(true, 'Writing your listing…');
  showError('');

  try {
    state.listing = await gemini.generate({
      prompt: listingPrompt({
        userNote: state.userNote,
        intake: state.intake,
        answers: state.answers,
        includeFrench: includeFrench(),
      }),
      assets: state.assets,
      schema: listingSchema,
      temperature: 0.65,
      signal: state.abort.signal,
      onRetry: (msg) => busy(true, msg),
    });
    renderListing(state.listing);
    goToStep(3);
  } catch (err) {
    if (err.name !== 'AbortError') showError(err.message);
  } finally {
    busy(false);
    state.abort = null;
  }
}

function restart() {
  state.assets = [];
  state.intake = null;
  state.answers = [];
  state.listing = null;
  state.addedSinceIntake = 0;
  $('user-note').value = '';
  $('file-input').value = '';
  show($('media-errors'), false);
  renderThumbs();
  goToStep(1);
}

/* ── Settings ─────────────────────────────────────────────────── */

function settingsStatus(message, kind = 'alert-info') {
  const el = $('settings-status');
  el.className = `alert ${kind}`;
  setText(el, message);
  show(el, Boolean(message));
}

/** The first-run prompt stays up until a key is actually stored. */
function refreshKeyState() {
  show($('setup-prompt'), !gemini.getApiKey());
}

/**
 * Fill the model dropdown from whatever the key can actually reach. Failures
 * are silent: automatic selection still works, so a dropdown that could not
 * populate is not worth an error message.
 */
async function populateModels({ refresh = false } = {}) {
  const select = $('model-select');
  const chosen = gemini.getModelOverride();
  if (!gemini.getApiKey()) return;

  let models = [];
  try {
    models = await gemini.availableModels({ refresh });
  } catch {
    return;
  }

  select.replaceChildren(
    Object.assign(document.createElement('option'), {
      value: '',
      textContent: models.length ? `Best available (${models[0].id})` : 'Best available (recommended)',
    }),
    ...models.map((m) =>
      Object.assign(document.createElement('option'), {
        value: m.id,
        textContent: m.stable ? m.id : `${m.id} (preview)`,
      }),
    ),
  );
  // A previously chosen model may have been retired since it was picked.
  select.value = models.some((m) => m.id === chosen) ? chosen : '';
}

function openSettings() {
  $('api-key-input').value = gemini.getApiKey();
  $('french-toggle').checked = includeFrench();
  settingsStatus('');
  $('settings-dialog').showModal();
  populateModels();
}

function wireSettings() {
  const keyInput = $('api-key-input');
  const frenchToggle = $('french-toggle');

  $('settings-btn').addEventListener('click', openSettings);
  $('setup-settings-btn').addEventListener('click', openSettings);

  $('save-settings-btn').addEventListener('click', () => {
    const keyChanged = keyInput.value.trim() !== gemini.getApiKey();
    gemini.setApiKey(keyInput.value);
    gemini.setModelOverride($('model-select').value);
    localStorage.setItem(FRENCH_STORAGE, frenchToggle.checked ? 'on' : 'off');
    // A different key may reach a different set of models.
    if (keyChanged) gemini.forgetModels();
    refreshKeyState();
    toast('Settings saved');
  });

  $('verify-key-btn').addEventListener('click', async () => {
    const key = keyInput.value.trim();
    if (!key) return settingsStatus('Paste a key first.', 'alert-error');
    settingsStatus('Checking…');
    try {
      const models = await gemini.verifyKey(key);
      gemini.setApiKey(key);
      gemini.forgetModels();
      await populateModels({ refresh: true });
      settingsStatus(`Key works. Using ${models[0].id}.`, 'alert-ok');
    } catch (err) {
      settingsStatus(err.message, 'alert-error');
    }
  });

  $('refresh-models-btn').addEventListener('click', async () => {
    if (!gemini.getApiKey()) return settingsStatus('Save your key first.', 'alert-error');
    settingsStatus('Checking which models your key can use…');
    try {
      await populateModels({ refresh: true });
      const models = await gemini.availableModels();
      settingsStatus(`${models.length} models available. Best: ${models[0].id}.`, 'alert-ok');
    } catch (err) {
      settingsStatus(err.message, 'alert-error');
    }
  });
}

/* ── Wiring ───────────────────────────────────────────────────── */

function wireApp() {
  const input = $('file-input');
  const zone = $('dropzone');

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  for (const type of ['dragenter', 'dragover']) {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.add('dragover');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.remove('dragover');
    });
  }
  zone.addEventListener('drop', (event) => handleFiles(event.dataTransfer?.files));

  input.addEventListener('change', async () => {
    await handleFiles(input.files);
    // Reset so picking the same file twice still fires a change event.
    input.value = '';
  });

  $('analyze-btn').addEventListener('click', runIntake);
  $('back-to-1').addEventListener('click', () => goToStep(1));
  $('generate-btn').addEventListener('click', runListing);
  $('skip-questions-btn').addEventListener('click', () => {
    for (const el of $('intake-questions').querySelectorAll('[data-answer]')) el.value = '';
    runListing();
  });

  // The single change listener above handles these too; the added-photo
  // counter is updated inside handleFiles once intake has run.
  $('add-more-btn').addEventListener('click', () => input.click());

  $('regenerate-btn').addEventListener('click', runListing);
  $('restart-btn').addEventListener('click', restart);
  $('cancel-btn').addEventListener('click', () => state.abort?.abort());
}

/* ── Boot ─────────────────────────────────────────────────────── */

function enterApp(user) {
  show($('auth-view'), false);
  show($('app-view'));
  show($('signout-btn'), auth.isEnabled());
  if (user?.email) {
    setText($('user-chip'), user.email);
    show($('user-chip'));
  }
  goToStep(1);
  refreshKeyState();
}

function showSignIn(message) {
  show($('app-view'), false);
  show($('auth-view'));
  if (message) {
    setText($('signin-error'), message);
    show($('signin-error'));
  }
}

function wireAuth() {
  $('signin-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    show($('signin-error'), false);
    try {
      const user = await auth.signIn($('signin-email').value, $('signin-password').value);
      enterApp(user);
    } catch (err) {
      setText($('signin-error'), err.message);
      show($('signin-error'));
    }
  });

  $('signout-btn').addEventListener('click', async () => {
    await auth.signOut();
    showSignIn('');
  });
}

async function boot() {
  wireSettings();
  wireApp();
  wireAuth();

  const { enabled, user, error } = await auth.init((changedUser) => {
    // Fired when a refresh fails and the session is dropped. Only react while
    // the app is showing, so a background expiry does not fight the UI.
    if (!changedUser && !$('app-view').hidden) showSignIn('Your session expired. Sign in again.');
  });

  if (!enabled) {
    enterApp(null);
    if (error) showError(error);
    return;
  }

  // A Supabase recovery or confirmation link lands back here with tokens in
  // the URL fragment.
  const redirectUser = await auth.consumeRedirect();
  const signedIn = redirectUser ?? user;

  if (signedIn) enterApp(signedIn);
  else showSignIn('');
}

boot();

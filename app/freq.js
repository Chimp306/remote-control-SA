/**
 * Signed-in personal date log. Entries stay in the account store.
 * A failed or offline attempt is not described as saved.
 * Auth callbacks do not call other auth methods, which avoids the client lock.
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm';
import { API_URL, PUBLISHABLE_KEY } from './config.js?v=20261107-v214';
import {
  TABLE,
  acceptOwnedRows,
  authTransition,
  classifyProbe,
  classifyWrite,
  describeAuthCallback,
  initialAuth,
  LINK_REQUEST_MESSAGE,
  localSignOut,
  pathWithoutAuthCallback,
  planWrite,
  presentEntries,
  projectUrl,
  renderLog,
  requestStillValid,
  summarize,
} from './freq-log.js?v=20261107-v217';

const root = document.getElementById('app');
const client = createClient(projectUrl(API_URL), PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
    storageKey: 'ctmp-freq-auth',
  },
});

let mode = 'checking';
let message = 'Checking the account store. Nothing has been saved.';
let session = null;
let auth = initialAuth();
let entries = [];
let editing = null;
let draft = null;
let pendingDeleteId = null;
let callbackNotice = '';

function online() {
  return navigator.onLine !== false;
}

function capture() {
  return { generation: auth.generation, userId: auth.userId };
}

function forgetPrivate() {
  entries = [];
  editing = null;
  draft = null;
  pendingDeleteId = null;
}

function viewState() {
  const shown = presentEntries(auth.userId, entries);
  return {
    mode: mode === 'ready' && !auth.userId ? 'signed-out' : mode,
    message,
    entries: shown,
    summary: summarize(shown),
    editing: auth.userId ? editing : null,
    draft: auth.userId ? draft : null,
    pendingDeleteId: auth.userId ? pendingDeleteId : null,
  };
}

function paint() {
  renderLog(root, viewState());
  bind();
}

function stripAuthParams() {
  const next = pathWithoutAuthCallback(location.href);
  if (next === location.pathname + location.search) return;
  history.replaceState(null, '', next);
}

function applyAuth(event, nextSession) {
  const next = authTransition(auth, event, nextSession?.user?.id || null);
  auth = { generation: next.generation, userId: next.userId };
  session = next.userId ? nextSession : null;
  if (next.clearPrivate) forgetPrivate();
  if (!next.userId && mode === 'ready') message = 'Signed out. Entries remain in the account store.';
  if (next.clearPrivate && mode === 'ready') paint();
  return next;
}

function noteAuthCallback(hasSession) {
  const notice = describeAuthCallback(location.href, hasSession);
  if (notice) callbackNotice = notice;
  stripAuthParams();
}

function onAuth(event, nextSession) {
  const next = applyAuth(event, nextSession);
  if (event === 'INITIAL_SESSION') {
    noteAuthCallback(Boolean(nextSession?.user?.id));
    if (callbackNotice && mode === 'ready' && !auth.userId) {
      message = callbackNotice;
      paint();
    }
  }
  if (next.action === 'refresh' || next.action === 'initial' || !next.userId || mode !== 'ready') return;
  const seen = capture();
  setTimeout(() => {
    if (!requestStillValid(seen, auth)) return;
    loadEntries(seen).then(() => {
      if (requestStillValid(seen, auth)) paint();
    });
  }, 0);
}

client.auth.onAuthStateChange((event, nextSession) => {
  onAuth(event, nextSession);
});

async function loadEntries(seen) {
  if (!requestStillValid(seen, auth)) return;
  const { data, error } = await client.from(TABLE).select('id,user_id,occurred_on,count,note,created_at').eq('user_id', seen.userId);
  if (!requestStillValid(seen, auth)) return;
  if (error) {
    entries = [];
    message = 'Not saved. The account store did not load entries.';
    return;
  }
  const owned = acceptOwnedRows(seen, auth, data);
  if (!owned) return;
  entries = owned;
  message = entries.length ? '' : 'No entries yet.';
}

async function probe() {
  mode = 'checking';
  message = 'Checking the account store. Nothing has been saved.';
  paint();
  try {
    if (!online()) {
      mode = 'offline';
      message = classifyProbe(null, false).message;
      paint();
      return;
    }
    const { error } = await client.from(TABLE).select('id').limit(1);
    const result = classifyProbe(error, true);
    mode = result.mode === 'ready' ? 'ready' : result.mode;
    message = result.message;
    if (mode === 'ready') {
      if (auth.userId) await loadEntries(capture());
      else message = callbackNotice || 'Sign in with the account for this log. The menu code is not this sign-in.';
    }
  } catch {
    mode = 'offline';
    message = 'The account store could not be checked. Nothing was saved.';
  }
  paint();
}

function readEntryForm() {
  return {
    occurredOn: document.getElementById('freq-date')?.value,
    count: document.getElementById('freq-count')?.value,
    note: document.getElementById('freq-note')?.value,
  };
}

async function saveEntry(event) {
  event.preventDefault();
  const seen = capture();
  const plan = planWrite(session, readEntryForm(), online());
  if (plan.state !== 'ready') {
    message = plan.message;
    paint();
    return;
  }
  const query = editing
    ? client.from(TABLE).update(plan.entry).eq('id', editing).eq('user_id', seen.userId).select('id,user_id,occurred_on,count,note,created_at').single()
    : client.from(TABLE).insert(plan.entry).select('id,user_id,occurred_on,count,note,created_at').single();
  let result;
  try { result = await query; }
  catch { result = { error: { message: 'Failed to fetch' }, data: null }; }
  if (!requestStillValid(seen, auth)) return;
  const outcome = classifyWrite(result.error, result.data, online());
  if (outcome.saved && !acceptOwnedRows(seen, auth, [result.data])) return;
  message = outcome.message;
  if (outcome.saved) {
    editing = null;
    draft = null;
    await loadEntries(seen);
    if (!requestStillValid(seen, auth)) return;
    message = outcome.message;
  }
  paint();
}

async function removeEntry(id) {
  const seen = capture();
  if (!requestStillValid(seen, auth) || !online()) {
    message = online() ? 'Not saved. Sign in before changing an entry.' : 'Not saved. This browser is offline.';
    paint();
    return;
  }
  let result;
  try {
    result = await client.from(TABLE).delete().eq('id', id).eq('user_id', seen.userId).select('id,user_id');
  } catch {
    result = { error: { message: 'Failed to fetch' }, data: null };
  }
  if (!requestStillValid(seen, auth)) return;
  const row = Array.isArray(result.data) ? result.data.find(item => item.user_id === seen.userId) : null;
  const outcome = classifyWrite(result.error, row, online());
  if (!outcome.saved) {
    message = outcome.message;
    paint();
    return;
  }
  pendingDeleteId = null;
  if (editing === id) { editing = null; draft = null; }
  await loadEntries(seen);
  if (!requestStillValid(seen, auth)) return;
  message = 'Deleted from your account.';
  paint();
}

async function signIn(event) {
  event.preventDefault();
  if (!online()) { message = 'Not signed in. This browser is offline.'; paint(); return; }
  const email = document.getElementById('freq-email')?.value.trim();
  const password = document.getElementById('freq-password')?.value || '';
  const passwordField = document.getElementById('freq-password');
  if (passwordField) passwordField.value = '';
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    message = 'Sign-in did not complete. This page cannot create the account.';
    paint();
  }
}

async function sendLink() {
  if (!online()) { message = 'Not signed in. This browser is offline.'; paint(); return; }
  const email = document.getElementById('freq-email')?.value.trim();
  if (!email) { message = 'Enter the email for the existing account.'; paint(); return; }
  const { error } = await client.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: `${location.origin}/FREQ/` },
  });
  message = error
    ? 'Sign-in link was not sent. This page cannot create the account.'
    : LINK_REQUEST_MESSAGE;
  paint();
}

async function signOutNow() {
  auth = localSignOut(auth);
  session = null;
  forgetPrivate();
  message = 'Signed out on this screen.';
  paint();
  try {
    await client.auth.signOut();
  } catch {
    message = 'Signed out on this screen. The account store could not be reached.';
    paint();
  }
}

function bind() {
  root.querySelector('[data-freq-auth]')?.addEventListener('submit', signIn);
  root.querySelector('[data-act="magic-link"]')?.addEventListener('click', sendLink);
  root.querySelector('[data-act="retry"]')?.addEventListener('click', () => { probe(); });
  root.querySelector('[data-freq-entry]')?.addEventListener('submit', saveEntry);
  root.querySelector('[data-act="cancel-edit"]')?.addEventListener('click', () => {
    editing = null;
    draft = null;
    message = '';
    paint();
  });
  root.querySelector('[data-act="sign-out"]')?.addEventListener('click', signOutNow);
  for (const button of root.querySelectorAll('[data-act="edit"]')) {
    button.addEventListener('click', () => {
      const row = entries.find(item => item.id === button.dataset.id && item.user_id === auth.userId);
      if (!row) return;
      editing = row.id;
      draft = row;
      pendingDeleteId = null;
      message = '';
      paint();
    });
  }
  for (const button of root.querySelectorAll('[data-act="delete"]')) {
    button.addEventListener('click', () => {
      pendingDeleteId = button.dataset.id;
      paint();
    });
  }
  for (const button of root.querySelectorAll('[data-act="confirm-delete"]')) {
    button.addEventListener('click', () => { removeEntry(button.dataset.id); });
  }
}

probe();

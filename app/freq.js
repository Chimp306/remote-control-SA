/**
 * Signed-in personal date log. Entries stay in the account store.
 * A failed or offline attempt is not described as saved.
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm';
import { API_URL, PUBLISHABLE_KEY } from './config.js?v=20261107-v214';
import {
  TABLE,
  classifyProbe,
  classifyWrite,
  planWrite,
  projectUrl,
  renderLog,
  summarize,
  visibleEntries,
} from './freq-log.js?v=20261107-v215';

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
let entries = [];
let editing = null;
let draft = null;
let pendingDeleteId = null;

function online() {
  return navigator.onLine !== false;
}

function viewState() {
  return {
    mode: mode === 'ready' && !session ? 'signed-out' : mode,
    message,
    entries,
    summary: summarize(entries),
    editing,
    draft,
    pendingDeleteId,
  };
}

function paint() {
  renderLog(root, viewState());
  bind();
}

function stripAuthParams() {
  const url = new URL(location.href);
  const hasCode = url.searchParams.has('code') || url.searchParams.has('access_token') || url.searchParams.has('error');
  if (!url.hash && !hasCode) return;
  history.replaceState(null, '', url.pathname);
}

async function refreshSession() {
  const { data } = await client.auth.getSession();
  session = data.session || null;
  stripAuthParams();
}

async function loadEntries() {
  if (!session?.user?.id) {
    entries = [];
    return;
  }
  const { data, error } = await client.from(TABLE).select('id,user_id,occurred_on,count,note,created_at').eq('user_id', session.user.id);
  if (error) {
    entries = [];
    message = 'Not saved. The account store did not load entries.';
    return;
  }
  entries = visibleEntries(data, session.user.id);
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
      await refreshSession();
      if (session) await loadEntries();
      else message = 'Sign in with the account for this log. The menu code is not this sign-in.';
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
  const plan = planWrite(session, readEntryForm(), online());
  if (plan.state !== 'ready') {
    message = plan.message;
    paint();
    return;
  }
  const query = editing
    ? client.from(TABLE).update(plan.entry).eq('id', editing).eq('user_id', session.user.id).select('id,user_id,occurred_on,count,note,created_at').single()
    : client.from(TABLE).insert(plan.entry).select('id,user_id,occurred_on,count,note,created_at').single();
  let result;
  try { result = await query; }
  catch { result = { error: { message: 'Failed to fetch' }, data: null }; }
  const outcome = classifyWrite(result.error, result.data, online());
  message = outcome.message;
  if (outcome.saved) {
    editing = null;
    draft = null;
    await loadEntries();
    message = outcome.message;
  }
  paint();
}

async function removeEntry(id) {
  if (!session?.user?.id || !online()) {
    message = online() ? 'Not saved. Sign in before changing an entry.' : 'Not saved. This browser is offline.';
    paint();
    return;
  }
  let result;
  try {
    result = await client.from(TABLE).delete().eq('id', id).eq('user_id', session.user.id).select('id');
  } catch {
    result = { error: { message: 'Failed to fetch' }, data: null };
  }
  const row = Array.isArray(result.data) ? result.data[0] : null;
  const outcome = classifyWrite(result.error, row, online());
  message = outcome.saved ? 'Deleted from your account.' : outcome.message;
  if (outcome.saved) {
    pendingDeleteId = null;
    if (editing === id) { editing = null; draft = null; }
    await loadEntries();
    message = 'Deleted from your account.';
  }
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
    return;
  }
  await refreshSession();
  await loadEntries();
  message = session ? 'Signed in.' : 'Sign-in did not complete. This page cannot create the account.';
  paint();
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
    : 'If that account exists, a sign-in link was requested. Nothing was saved.';
  paint();
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
  root.querySelector('[data-act="sign-out"]')?.addEventListener('click', async () => {
    await client.auth.signOut();
    session = null;
    entries = [];
    editing = null;
    draft = null;
    message = 'Signed out. Entries remain in the account store.';
    paint();
  });
  for (const button of root.querySelectorAll('[data-act="edit"]')) {
    button.addEventListener('click', () => {
      const row = entries.find(item => item.id === button.dataset.id);
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

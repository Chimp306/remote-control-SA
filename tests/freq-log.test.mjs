import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  acceptOwnedRows,
  authTransition,
  classifyProbe,
  classifyWrite,
  initialAuth,
  localSignOut,
  planWrite,
  presentEntries,
  projectUrl,
  renderLog,
  requestStillValid,
  summarize,
  validateEntry,
  visibleEntries,
} from '../app/freq-log.js';

const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');

function createDocument() {
  function createElement(tag) {
    return {
      tag,
      className: '',
      children: [],
      textContent: '',
      attrs: {},
      setAttribute(key, value) { this.attrs[key] = String(value); },
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = nodes.length ? [...nodes] : []; },
    };
  }
  return { createElement };
}

function textOf(node) {
  return `${node.textContent || ''}\n${(node.children || []).map(textOf).join('\n')}`;
}

function hasTag(node, tag) {
  if (node.tag === tag) return true;
  return (node.children || []).some(child => hasTag(child, tag));
}

test('validation accepts a date and count and rejects markup-sized or impossible values', () => {
  const today = new Date(Date.UTC(2026, 10, 7));
  const good = validateEntry({ occurredOn: '2026-11-07', count: '2', note: 'evening', today });
  assert.equal(good.ok, true);
  assert.deepEqual(good.entry, { occurred_on: '2026-11-07', count: 2, note: 'evening' });
  assert.equal(validateEntry({ occurredOn: '2026-02-31', count: '1', today }).ok, false);
  assert.equal(validateEntry({ occurredOn: '2026-11-07', count: '1e1', today }).ok, false);
  assert.equal(validateEntry({ occurredOn: '2026-11-07', count: '100', today }).ok, false);
  assert.equal(validateEntry({ occurredOn: '1999-01-01', count: '1', today }).ok, false);
  assert.equal(validateEntry({ occurredOn: '2026-11-07', count: '1', note: 'x'.repeat(281), today }).ok, false);
});

test('history sums the signed-in rows and drops any other user', () => {
  const rows = visibleEntries([
    { id: 'a', user_id: 'me', occurred_on: '2026-11-01', count: 1, note: 'one', created_at: '1' },
    { id: 'b', user_id: 'other', occurred_on: '2026-11-02', count: 9, note: 'hidden', created_at: '2' },
    { id: 'c', user_id: 'me', occurred_on: '2026-10-03', count: 2, note: '', created_at: '3' },
  ], 'me');
  assert.deepEqual(rows.map(row => row.id), ['a', 'c']);
  const summary = summarize(rows);
  assert.equal(summary.entries, 2);
  assert.equal(summary.total, 3);
  assert.equal(summary.latest, '2026-11-01');
  assert.deepEqual(summary.months.map(month => month.month), ['2026-11', '2026-10']);
});

test('unsigned, offline, and rejected writes are not described as saved', () => {
  assert.equal(planWrite(null, { occurredOn: '2026-11-07', count: '1' }).saved, false);
  assert.match(planWrite(null, { occurredOn: '2026-11-07', count: '1' }).message, /Not saved/);
  const offline = planWrite({ user: { id: 'me' } }, { occurredOn: '2026-11-07', count: '1', today: new Date(Date.UTC(2026, 10, 7)) }, false);
  assert.equal(offline.saved, false);
  assert.equal(offline.state, 'offline');
  const ready = planWrite({ user: { id: 'me' } }, { occurredOn: '2026-11-07', count: '1', today: new Date(Date.UTC(2026, 10, 7)) }, true);
  assert.equal(ready.entry.user_id, 'me');
  assert.equal(classifyWrite({ message: 'permission denied' }, null).saved, false);
  assert.match(classifyWrite({ message: 'permission denied' }, null).message, /Not saved/);
  assert.equal(classifyWrite(null, { id: 'row-1' }).saved, true);
  assert.equal(classifyProbe({ code: 'PGRST205', message: 'Could not find the table' }).mode, 'unconfigured');
  assert.match(classifyProbe({ code: 'PGRST205', message: 'Could not find the table' }).message, /does not accept or save/);
  assert.equal(classifyProbe(null, false).mode, 'offline');
  assert.equal(classifyProbe({ code: '42501', message: 'permission denied for table freq_entries' }).mode, 'ready');
});

test('notes are text, including markup, and an unconfigured page has no save form', () => {
  const doc = createDocument();
  const root = doc.createElement('div');
  const hostile = '<img src=x onerror=alert(1)>';
  renderLog(root, {
    mode: 'ready',
    message: 'Saved to your account.',
    entries: [{ id: '1', user_id: 'me', occurred_on: '2026-11-01', count: 1, note: hostile, created_at: '1' }],
  }, doc);
  const text = textOf(root);
  assert.match(text, /<img src=x onerror=alert\(1\)>/);
  assert.equal(hasTag(root, 'img'), false);
  assert.equal(hasTag(root, 'script'), false);
  renderLog(root, {
    mode: 'unconfigured',
    message: 'Cross-device storage is not set up. This page does not accept or save entries.',
    entries: [],
  }, doc);
  assert.match(textOf(root), /does not accept or save entries/);
  assert.equal(textOf(root).includes('Saved to your account'), false);
  assert.equal(hasTag(root, 'form'), false);
});

test('the migration isolates the owner and the page does not use the control service', () => {
  const sql = read('../supabase/migrations/20261107225111_freq_entries.sql').replace(/--.*$/gm, '');
  const page = read('../app/freq.js');
  const logic = read('../app/freq-log.js');
  const constraintSql = sql.slice(0, sql.indexOf('create or replace function'));
  assert.equal(constraintSql.includes('current_date'), false);
  assert.match(sql, /new\.occurred_on > \(current_date \+ 1\)/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /force row level security/);
  assert.match(sql, /revoke all on table public\.freq_entries from public, anon, authenticated, service_role/);
  assert.match(sql, /grant select, insert, update, delete on table public\.freq_entries to authenticated/);
  assert.equal(sql.includes('to anon'), false);
  assert.equal(sql.includes('ctmp_v2'), false);
  assert.equal(sql.includes('ctmp-control'), false);
  assert.equal((sql.match(/user_id = \(select auth\.uid\(\)\)/g) || []).length, 5);
  assert.equal(page.includes('innerHTML'), false);
  assert.equal(logic.includes('innerHTML'), false);
  assert.equal(page.includes('localStorage'), false);
  assert.equal(page.includes('ctmp-control'), false);
  assert.equal(page.includes('service_role'), false);
  assert.equal(page.includes('guest-access'), false);
  assert.match(page, /shouldCreateUser: false/);
  assert.match(page, /storageKey: 'ctmp-freq-auth'/);
  assert.equal(projectUrl('https://hqciviafxtfescteyvnn.supabase.co/functions/v1/ctmp-control'), 'https://hqciviafxtfescteyvnn.supabase.co');
  const setup = read('../supabase/freq-setup.md');
  assert.match(setup, /Do not paste the service-role key/);
  assert.match(setup, /does not choose an email/);
  const raw = read('../supabase/migrations/20261107225111_freq_entries.sql');
  assert.match(raw, /20261107225111/);
  assert.equal(raw.includes('create table if not exists'), true);
});

function row(id, userId, note) {
  return { id, user_id: userId, occurred_on: '2026-11-01', count: 1, note, created_at: '1' };
}

test('a late read or write cannot restore entries after sign-out, expiry, or an account switch', () => {
  let state = authTransition(initialAuth(), 'SIGNED_IN', 'account-a');
  const first = { generation: state.generation, userId: state.userId };
  for (let i = 0; i < 5; i += 1) state = authTransition(state, 'TOKEN_REFRESHED', 'account-a');
  assert.equal(state.generation, first.generation);
  assert.equal(state.action, 'refresh');
  assert.equal(requestStillValid(first, state), true);
  state = authTransition(state, 'TOKEN_REFRESHED', null);
  assert.equal(state.userId, null);
  assert.equal(state.clearPrivate, true);
  assert.equal(acceptOwnedRows(first, state, [row('a', 'account-a', 'private')]), null);
  assert.deepEqual(presentEntries(state.userId, [row('a', 'account-a', 'private')]), []);
  state = authTransition(initialAuth(), 'SIGNED_IN', 'account-a');
  const duringA = { generation: state.generation, userId: state.userId };
  state = authTransition(state, 'SIGNED_OUT', null);
  assert.equal(state.action, 'clear');
  assert.equal(acceptOwnedRows(duringA, state, [row('a', 'account-a', 'private')]), null);
  state = authTransition(state, 'SIGNED_IN', 'account-b');
  const duringB = { generation: state.generation, userId: state.userId };
  const visible = acceptOwnedRows(duringB, state, [row('a', 'account-a', 'private'), row('b', 'account-b', 'mine')]);
  assert.deepEqual(visible.map(item => item.id), ['b']);
  assert.equal(acceptOwnedRows(duringA, state, [row('a', 'account-a', 'private')]), null);
  const signedOut = localSignOut(state);
  assert.equal(signedOut.clearPrivate, true);
  assert.equal(signedOut.userId, null);
  assert.equal(requestStillValid(duringB, signedOut), false);
});

test('the page subscribes to auth changes and clears the screen before sign-out can fail', () => {
  const page = read('../app/freq.js');
  const callback = page.slice(page.indexOf('client.auth.onAuthStateChange'), page.indexOf('async function loadEntries'));
  assert.match(callback, /onAuthStateChange\(\(event, nextSession\) =>/);
  assert.equal(callback.includes('await'), false);
  assert.equal(callback.includes('getSession'), false);
  assert.equal(callback.includes('.signOut'), false);
  const signOut = page.slice(page.indexOf('async function signOutNow'), page.indexOf('function bind'));
  const cleared = signOut.indexOf('forgetPrivate()');
  const awaited = signOut.indexOf('await client.auth.signOut');
  assert.ok(cleared > -1 && awaited > cleared);
  assert.match(signOut, /localSignOut\(auth\)/);
  assert.match(signOut, /catch/);
});

/**
 * Pure rules for the personal date log. This module does not talk to the
 * network and does not store entries.
 */

export const NOTE_LIMIT = 280;
export const COUNT_MAX = 99;
export const TABLE = 'freq_entries';

export function projectUrl(apiUrl) {
  return new URL(apiUrl).origin;
}

export function validateEntry(input) {
  const occurredOn = String(input?.occurredOn ?? input?.occurred_on ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) return { ok: false, message: 'Enter a date.' };
  const [year, month, day] = occurredOn.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { ok: false, message: 'Enter a real date.' };
  }
  const now = input?.today instanceof Date ? input.today : new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (date.getTime() < Date.UTC(2000, 0, 1) || date.getTime() > todayUtc + 86400000) {
    return { ok: false, message: 'That date is outside the log range.' };
  }
  const countText = String(input?.count ?? '').trim();
  if (!/^\d{1,2}$/.test(countText)) return { ok: false, message: 'Enter a whole count from 0 to 99.' };
  const count = Number(countText);
  if (count > COUNT_MAX) return { ok: false, message: 'Enter a whole count from 0 to 99.' };
  const note = String(input?.note ?? '');
  if (note.length > NOTE_LIMIT) return { ok: false, message: 'The note is too long.' };
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(note)) return { ok: false, message: 'The note has unsupported characters.' };
  return { ok: true, entry: { occurred_on: occurredOn, count, note: note.trim() } };
}

export function visibleEntries(rows, userId) {
  return (Array.isArray(rows) ? rows : []).filter(row => row && row.user_id === userId && row.id);
}

export function initialAuth() {
  return { generation: 0, userId: null };
}

export function authTransition(state, event, nextUserId) {
  const nextId = nextUserId || null;
  const prevId = state.userId;
  if (event === 'TOKEN_REFRESHED' && nextId && nextId === prevId) {
    return { generation: state.generation, userId: nextId, action: 'refresh', clearPrivate: false };
  }
  if ((event === 'SIGNED_IN' || event === 'USER_UPDATED') && nextId && nextId === prevId) {
    return { generation: state.generation, userId: nextId, action: 'refresh', clearPrivate: false };
  }
  if (event === 'INITIAL_SESSION' && state.generation === 0) {
    return { generation: 0, userId: nextId, action: 'initial', clearPrivate: false };
  }
  return {
    generation: state.generation + 1,
    userId: nextId,
    action: nextId ? (nextId === prevId ? 'same' : 'switch') : 'clear',
    clearPrivate: nextId !== prevId,
  };
}

export function localSignOut(state) {
  return { generation: state.generation + 1, userId: null, action: 'clear', clearPrivate: true };
}

export function requestStillValid(captured, state) {
  return Boolean(captured)
    && captured.generation === state.generation
    && captured.userId === state.userId
    && state.userId != null;
}

export function acceptOwnedRows(captured, state, rows) {
  if (!requestStillValid(captured, state)) return null;
  return visibleEntries(rows, state.userId);
}

export function presentEntries(userId, entries) {
  if (!userId) return [];
  return visibleEntries(entries, userId);
}

export function summarize(entries) {
  const rows = [...entries].sort((a, b) => {
    if (a.occurred_on === b.occurred_on) return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    return a.occurred_on < b.occurred_on ? 1 : -1;
  });
  const months = [];
  for (const row of rows) {
    const month = String(row.occurred_on).slice(0, 7);
    let bucket = months.find(item => item.month === month);
    if (!bucket) {
      bucket = { month, entries: 0, count: 0 };
      months.push(bucket);
    }
    bucket.entries += 1;
    bucket.count += Number(row.count) || 0;
  }
  return {
    entries: rows.length,
    total: rows.reduce((sum, row) => sum + (Number(row.count) || 0), 0),
    latest: rows[0]?.occurred_on || '',
    months,
    rows,
  };
}

export function classifyProbe(error, online = true) {
  if (!online) return { mode: 'offline', message: 'The account store could not be checked. Nothing was saved.' };
  if (!error) return { mode: 'ready', message: '' };
  const code = String(error.code || '');
  const message = String(error.message || '');
  if (code === 'PGRST205' || code === '42P01' || /schema cache|does not exist|could not find the table/i.test(message)) {
    return { mode: 'unconfigured', message: 'Cross-device storage is not set up. This page does not accept or save entries.' };
  }
  if (/failed to fetch|network|offline|load failed/i.test(message)) {
    return { mode: 'offline', message: 'The account store could not be checked. Nothing was saved.' };
  }
  if (code === '42501' || /permission denied|row-level security/i.test(message)) {
    return { mode: 'ready', message: '' };
  }
  return { mode: 'error', message: 'The account store could not be checked. Nothing was saved.' };
}

export function planWrite(session, input, online = true) {
  if (!session?.user?.id) {
    return { saved: false, state: 'signed-out', message: 'Not saved. Sign in before adding an entry.' };
  }
  const parsed = validateEntry(input);
  if (!parsed.ok) return { saved: false, state: 'invalid', message: parsed.message };
  if (!online) return { saved: false, state: 'offline', message: 'Not saved. This browser is offline.', entry: parsed.entry };
  return { saved: false, state: 'ready', message: '', entry: { ...parsed.entry, user_id: session.user.id } };
}

export function classifyWrite(error, data, online = true) {
  if (!online) return { saved: false, state: 'offline', message: 'Not saved. This browser is offline.' };
  if (error || !data?.id) return { saved: false, state: 'error', message: 'Not saved. The account store did not accept this change.' };
  return { saved: true, state: 'synced', message: 'Saved to your account.', entry: data };
}

function el(doc, tag, text, attrs = {}) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  if (text != null) node.textContent = text;
  return node;
}

export function renderLog(root, state, doc = root.ownerDocument || globalThis.document) {
  root.replaceChildren();
  const shell = el(doc, 'main', null, { class: 'shell', 'data-freq': state.mode });
  shell.append(el(doc, 'p', 'FREQ', { class: 'eyebrow' }));
  shell.append(el(doc, 'h1', 'Dates and notes'));
  shell.append(el(doc, 'p', 'A personal log of dates, counts, and optional short notes. Nothing here is scored, and nothing is collected automatically. The menu code does not sign you in.', { class: 'note' }));

  if (state.mode === 'checking') {
    shell.append(el(doc, 'p', 'Checking the account store. Nothing has been saved.', { class: 'note', role: 'status' }));
  } else if (state.mode !== 'ready') {
    const panel = el(doc, 'section', null, { class: 'panel unavailable' });
    const title = state.mode === 'signed-out' ? 'Sign in' : 'Not available yet';
    panel.append(el(doc, 'h2', title));
    panel.append(el(doc, 'p', state.message || 'This page does not accept or save entries.', { class: 'note', role: 'status', 'data-freq-status': '1' }));
    if (state.mode === 'signed-out') {
      const form = el(doc, 'form', null, { 'data-freq-auth': '1', autocomplete: 'on' });
      form.append(el(doc, 'label', 'Email', { for: 'freq-email' }));
      form.append(el(doc, 'input', null, { id: 'freq-email', type: 'email', autocomplete: 'username', required: 'required' }));
      form.append(el(doc, 'label', 'Password', { for: 'freq-password' }));
      form.append(el(doc, 'input', null, { id: 'freq-password', type: 'password', autocomplete: 'current-password' }));
      form.append(el(doc, 'button', 'Sign in', { class: 'button button-primary', type: 'submit' }));
      form.append(el(doc, 'button', 'Email me a sign-in link', { class: 'button', type: 'button', 'data-act': 'magic-link' }));
      panel.append(form);
      panel.append(el(doc, 'p', 'This page cannot create the account. Sign-in works after that account exists.', { class: 'note' }));
    } else if (state.mode === 'offline' || state.mode === 'error') {
      panel.append(el(doc, 'button', 'Try again', { class: 'button', type: 'button', 'data-act': 'retry' }));
    }
    shell.append(panel);
  } else {
    const summary = state.summary || summarize(state.entries || []);
    const history = el(doc, 'section', null, { class: 'panel', 'aria-label': 'Frequency' });
    history.append(el(doc, 'h2', 'History'));
    history.append(el(doc, 'p', `Entries ${summary.entries}. Total count ${summary.total}. Latest ${summary.latest || 'none'}.`, { 'data-freq-summary': '1' }));
    const months = el(doc, 'ul', null, { class: 'freq-months' });
    for (const bucket of summary.months) {
      months.append(el(doc, 'li', `${bucket.month}: ${bucket.entries} entries, count ${bucket.count}`));
    }
    history.append(months);
    shell.append(history);

    const editor = el(doc, 'section', null, { class: 'panel' });
    editor.append(el(doc, 'h2', state.editing ? 'Edit entry' : 'Add entry'));
    const form = el(doc, 'form', null, { 'data-freq-entry': '1' });
    form.append(el(doc, 'label', 'Date', { for: 'freq-date' }));
    form.append(el(doc, 'input', null, { id: 'freq-date', type: 'date', required: 'required', value: state.draft?.occurred_on || '' }));
    form.append(el(doc, 'label', 'Count', { for: 'freq-count' }));
    form.append(el(doc, 'input', null, { id: 'freq-count', type: 'number', min: '0', max: '99', inputmode: 'numeric', required: 'required', value: state.draft?.count ?? '' }));
    form.append(el(doc, 'label', 'Note, optional', { for: 'freq-note' }));
    const note = el(doc, 'textarea', state.draft?.note || '', { id: 'freq-note', maxlength: String(NOTE_LIMIT), rows: '3' });
    form.append(note);
    form.append(el(doc, 'button', state.editing ? 'Save changes' : 'Save entry', { class: 'button button-primary', type: 'submit' }));
    if (state.editing) form.append(el(doc, 'button', 'Cancel edit', { class: 'button', type: 'button', 'data-act': 'cancel-edit' }));
    editor.append(form);
    editor.append(el(doc, 'p', state.message || '', { class: 'note', role: 'status', 'data-freq-status': '1' }));
    shell.append(editor);

    const list = el(doc, 'ul', null, { class: 'freq-list' });
    if (!summary.rows.length) list.append(el(doc, 'li', 'No entries yet.'));
    for (const row of summary.rows) {
      const item = el(doc, 'li', null, { 'data-id': row.id });
      item.append(el(doc, 'span', row.occurred_on, { class: 'freq-date' }));
      item.append(el(doc, 'span', `Count ${row.count}`, { class: 'freq-count' }));
      item.append(el(doc, 'p', row.note || '', { class: 'freq-note' }));
      item.append(el(doc, 'button', 'Edit', { class: 'button', type: 'button', 'data-act': 'edit', 'data-id': row.id }));
      const deleting = state.pendingDeleteId === row.id;
      item.append(el(doc, 'button', deleting ? 'Confirm delete' : 'Delete', {
        class: 'button',
        type: 'button',
        'data-act': deleting ? 'confirm-delete' : 'delete',
        'data-id': row.id,
      }));
      list.append(item);
    }
    shell.append(list);
    shell.append(el(doc, 'button', 'Sign out', { class: 'button', type: 'button', 'data-act': 'sign-out' }));
  }

  shell.append(el(doc, 'a', 'Back to the menu', { class: 'text-link', href: '/' }));
  root.append(shell);
  return shell;
}

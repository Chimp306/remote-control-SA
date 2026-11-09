/**
 * Privacy cover for the root menu. The digest comparison is not an account
 * login: the expected digest is in this file, and each section can be opened
 * directly. The typed value is never stored or logged.
 */

export const MENU_DIGEST = '5872b2dc693ebfa8adb71c74cb583a78c20f8c0ee5d49dad9e89d749b24ca1af';
const COVER_FLAG = 'ctmp.cover.v1';

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function hexEqual(actual, expected) {
  const left = String(actual || '').toLowerCase();
  const right = String(expected || '').toLowerCase();
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export async function passcodeMatches(typed, expected = MENU_DIGEST) {
  return hexEqual(await sha256Hex(typed), expected);
}

export function coverMarkup() {
  return `
    <main class="shell" data-screen="cover">
      <div class="brand"><h1>CTMP</h1><small>Menu</small></div>
      <section class="panel">
        <h2>Continue</h2>
        <p class="note">This cover only hides the menu on this screen. It is not an account login. Opening a section by its address does not ask for this code.</p>
        <form data-cover autocomplete="off">
          <label for="cover-code">Code</label>
          <input id="cover-code" name="cover-code" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done">
          <button class="button button-primary" type="submit">Continue</button>
        </form>
        <p class="note" data-cover-status role="status"></p>
      </section>
    </main>`;
}

export function menuMarkup() {
  return `
    <main class="shell" data-screen="menu">
      <div class="brand"><h1>CTMP</h1><small>Menu</small></div>
      <nav class="menu" aria-label="Sections">
        <a class="menu-link" href="/solo/"><b>SOLO</b><span>Manual control</span></a>
        <a class="menu-link" href="/suc/"><b>SUC</b><span>Yield hall</span></a>
      </nav>
      <p class="note">The cover on the previous screen is not an account. These addresses open without it.</p>
      <button class="button" type="button" data-act="lock">Cover the menu</button>
    </main>`;
}

function show(root, markup, bind) {
  root.innerHTML = markup;
  bind(root);
}

function bindCover(root) {
  const form = root.querySelector('[data-cover]');
  const status = root.querySelector('[data-cover-status]');
  const field = root.querySelector('#cover-code');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const typed = field.value;
    field.value = '';
    let ok = false;
    try { ok = await passcodeMatches(typed); } catch { ok = false; }
    if (!ok) {
      status.textContent = 'That code does not match.';
      return;
    }
    try { sessionStorage.setItem(COVER_FLAG, '1'); } catch { /* the menu can still open */ }
    show(root, menuMarkup(), bindMenu);
  });
}

function bindMenu(root) {
  root.querySelector('[data-act="lock"]')?.addEventListener('click', () => {
    try { sessionStorage.removeItem(COVER_FLAG); } catch { /* ignore */ }
    show(root, coverMarkup(), bindCover);
  });
}

export function mountCover(root) {
  let open = false;
  try { open = sessionStorage.getItem(COVER_FLAG) === '1'; } catch { open = false; }
  show(root, open ? menuMarkup() : coverMarkup(), open ? bindMenu : bindCover);
}

if (typeof document !== 'undefined' && document.getElementById('app')) {
  mountCover(document.getElementById('app'));
}

/**
 * Local pictures and a trace of commanded output for the /PC player.
 * Files never leave the browser. Only one object URL is live at a time.
 */

const SUPPORTED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/avif',
]);

export function isPcRoute(pathname) {
  return pathname === '/PC' || pathname === '/PC/';
}

export function directorySelectionSupported() {
  return typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype;
}

export function isSupportedImage(file) {
  if (!file || typeof file.name !== 'string') return false;
  if (!Number.isFinite(file.size) || file.size <= 0) return false;
  const type = String(file.type || '').toLowerCase();
  const name = file.name.toLowerCase();
  if (type === 'image/svg+xml' || type === 'text/html' || type === 'application/xhtml+xml') return false;
  if (name.endsWith('.svg') || name.endsWith('.html') || name.endsWith('.htm') || name.endsWith('.js')) return false;
  if (SUPPORTED_TYPES.has(type)) return true;
  if (type.startsWith('image/')) return false;
  return /\.(jpe?g|png|gif|webp|bmp|avif)$/.test(name);
}

function shuffle(indices, random, avoid) {
  const list = indices.slice();
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  if (list.length > 1 && list[0] === avoid) [list[0], list[1]] = [list[1], list[0]];
  return list;
}

export function createPictureDeck({ createUrl, revokeUrl, random = Math.random } = {}) {
  if (typeof createUrl !== 'function' || typeof revokeUrl !== 'function') {
    throw new TypeError('Picture deck needs object URL create and revoke functions.');
  }
  let files = [];
  let order = [];
  let position = 0;
  let activeUrl = null;
  let shown = null;

  function show() {
    if (!files.length) return null;
    const file = files[order[position]];
    if (shown !== file) {
      if (activeUrl) revokeUrl(activeUrl);
      activeUrl = createUrl(file);
      shown = file;
    }
    return { url: activeUrl, name: file.name, index: position + 1, total: files.length };
  }

  return {
    replace(list) {
      this.dispose();
      const incoming = Array.from(list || []);
      const skipped = incoming.filter(file => !isSupportedImage(file));
      files = incoming.filter(isSupportedImage);
      order = shuffle(files.map((_, index) => index), random, null);
      position = 0;
      if (!incoming.length) return { ok: false, message: 'No pictures selected. Choose a folder or some image files. Nothing was uploaded.' };
      const skippedNote = skipped.length ? ` Skipped ${skipped.length} unsupported or empty file${skipped.length === 1 ? '' : 's'}.` : '';
      if (!files.length) return { ok: false, message: `No supported pictures.${skippedNote}` };
      return {
        ok: true,
        message: `${files.length} picture${files.length === 1 ? '' : 's'}, shuffled. No immediate repeat when another picture is available. Files stay on this device.${skippedNote}`,
        current: show(),
      };
    },
    current() { return show(); },
    advance() {
      if (files.length < 2) return show();
      const avoid = order[position];
      position += 1;
      if (position >= order.length) {
        order = shuffle(files.map((_, index) => index), random, avoid);
        position = 0;
      }
      return show();
    },
    dispose() {
      if (activeUrl) revokeUrl(activeUrl);
      activeUrl = null;
      shown = null;
      files = [];
      order = [];
      position = 0;
    },
  };
}

export function pictureLoadFailureMessage() {
  return 'This picture could not be shown. Next and Stop still work.';
}

export function advanceDeckOnEdge(deck, previousCount, nextCount) {
  if (!deck || nextCount === previousCount) return previousCount;
  deck.advance();
  return nextCount;
}

export function createPatternTrace(limit = 90) {
  const samples = [];
  return {
    push(a, b) {
      const next = {
        a: Number.isFinite(a) ? a : 0,
        b: Number.isFinite(b) ? b : 0,
      };
      const last = samples[samples.length - 1];
      if (last && last.a === next.a && last.b === next.b) return;
      samples.push(next);
      if (samples.length > limit) samples.shift();
    },
    samples() { return samples.slice(); },
    relation() {
      const last = samples[samples.length - 1];
      if (!last) return 'waiting';
      if (samples.every(sample => sample.a === 0 && sample.b === 0)) return 'stopped';
      if (last.a === 0 && last.b === 0) return 'at zero';
      if (samples.length < 3) return 'waiting';
      let agree = 0;
      let oppose = 0;
      for (let i = 1; i < samples.length; i += 1) {
        const da = samples[i].a - samples[i - 1].a;
        const db = samples[i].b - samples[i - 1].b;
        if (Math.abs(da) < 0.5 && Math.abs(db) < 0.5) continue;
        if (da * db > 0) agree += 1;
        else if (da * db < 0) oppose += 1;
      }
      if (agree === 0 && oppose === 0) return 'steady';
      if (oppose > agree) return 'opposed';
      if (agree > oppose) return 'in phase';
      return 'moving';
    },
  };
}

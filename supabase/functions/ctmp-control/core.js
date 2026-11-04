export const PATTERNS = ['steady','pulse','wave'];
const OPOSSUM_PATTERNS = [...PATTERNS,'alternating','offset-wave'];
export const PHASES = ['idle', 'running', 'cooldown', 'settling', 'paused', 'stopped', 'fault'];
export const isToken = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const normalizeCode = (value) => typeof value === 'string' ? value.trim().toUpperCase() : '';
export const isCode = (value) => /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/.test(normalizeCode(value));
export const isClient = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export const finite = (value, min, max, fallback) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

export function sanitizeState(value, toy, simulation = false) {
  const s = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const phase = PHASES.includes(s.phase) ? s.phase : 'paused';
  const dual = toy === 'opossum';
  // Older hosts exposed only one scalar output. Treat that as A-only so an
  // existing client never starts a second channel merely by being upgraded.
  const guestPercentA = dual ? finite(s.guestPercentA === undefined ? s.guestPercent : s.guestPercentA, 0, 100, 0) : 0;
  const guestPercentB = dual ? finite(s.guestPercentB, 0, 100, 0) : 0;
  const outputPercentA = dual && phase === 'running' ? finite(s.outputPercentA === undefined ? s.outputPercent : s.outputPercentA, 0, 100, 0) : 0;
  const outputPercentB = dual && phase === 'running' ? finite(s.outputPercentB, 0, 100, 0) : 0;
  return {
    phase, toy, mode: 'guest', simulation,
    pressure: finite(s.pressure, -100, 100, null),
    threshold: finite(s.threshold, 0, 59.9, null),
    resetThreshold: finite(s.resetThreshold, -100, 59.8, null),
    edgeCount: Math.floor(finite(s.edgeCount, 0, 1000000, 0)),
    newRecord: s.newRecord === true,
    outputPercent: dual ? Math.max(outputPercentA, outputPercentB) : phase === 'running' ? finite(s.outputPercent, 0, 100, 0) : 0,
    guestPercent: dual ? Math.max(guestPercentA, guestPercentB) : finite(s.guestPercent, 0, 100, 0),
    outputPercentA, outputPercentB, guestPercentA, guestPercentB,
    maxPercentA: dual ? finite(s.maxPercentA, 0, 100, 100) : 0,
    maxPercentB: dual ? finite(s.maxPercentB, 0, 100, 100) : 0,
    pattern: ['lush','opossum'].includes(toy) && (toy === 'opossum' ? OPOSSUM_PATTERNS : PATTERNS).includes(s.pattern) ? s.pattern : 'steady',
    recoveryMinSeconds: finite(s.recoveryMinSeconds, 1, 300, finite(s.cooldownSeconds,10,30,20)),
    recoveryMaxSeconds: finite(s.recoveryMaxSeconds, 1, 300, finite(s.cooldownSeconds,10,30,20)),
    recoveryBaseSeconds: finite(s.recoveryBaseSeconds, 1, 300, finite(s.cooldownSeconds,10,30,20)),
    recoverySeconds: finite(s.recoverySeconds, 1, 1800, finite(s.cooldownSeconds,10,30,20)),
    cooldownSeconds: finite(s.cooldownSeconds, 10, 30, 20),
    adaptiveMultiplier: finite(s.adaptiveMultiplier, 1, 32, 1),
    lastCycleSeconds: finite(s.lastCycleSeconds, 0, 86400, null),
    cooldownEndsAt: finite(s.cooldownEndsAt, 0, 9007199254740991, null),
    remainingCooldown: finite(s.remainingCooldown, 0, 1800, 0),
    epoch: Number.isSafeInteger(s.epoch) && s.epoch >= 0 ? s.epoch : 0,
    reason: typeof s.reason === 'string' ? s.reason.slice(0, 120) : '',
  };
}

export function sanitizeCommand(value, toy) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid controls');
  const dual = toy === 'opossum';
  const usesRange = value.recoveryMinSeconds !== undefined || value.recoveryMaxSeconds !== undefined;
  const allowed = ['percent','pattern','cooldownSeconds','epoch','clientSeq', ...(usesRange ? ['recoveryMinSeconds','recoveryMaxSeconds'] : []), ...(dual ? ['percentA','percentB'] : [])];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unsupported control');
  const hasChannels = dual && ('percentA' in value || 'percentB' in value);
  const numeric = ['epoch','clientSeq', ...(hasChannels ? ['percentA','percentB'] : ['percent'])];
  if (hasChannels && 'percent' in value) numeric.push('percent');
  for (const field of numeric) if (typeof value[field] !== 'number' || !Number.isFinite(value[field])) throw new Error('Invalid controls');
  if (!Number.isSafeInteger(value.epoch) || value.epoch < 0 || !Number.isSafeInteger(value.clientSeq) || value.clientSeq < 1) throw new Error('Invalid sequence');
  if (numeric.filter(field => field.startsWith('percent')).some(field => value[field] < 0 || value[field] > 100)) throw new Error('Controls outside limits');
  let recoveryFields = {};
  if (usesRange) {
    const min = value.recoveryMinSeconds, max = value.recoveryMaxSeconds;
    if (typeof min !== 'number' || !Number.isFinite(min) || typeof max !== 'number' || !Number.isFinite(max) || min < 1 || min > 300 || max < min || max > 300) throw new Error('Recovery range outside limits');
    recoveryFields = { recoveryMinSeconds: Math.round(min), recoveryMaxSeconds: Math.round(max) };
  } else {
    if (typeof value.cooldownSeconds !== 'number' || !Number.isFinite(value.cooldownSeconds)) throw new Error('Invalid controls');
    if (value.cooldownSeconds < 10 || value.cooldownSeconds > 30) throw new Error('Controls outside limits');
    recoveryFields = { cooldownSeconds: Math.round(value.cooldownSeconds) };
  }
  const allowedPatterns = dual ? OPOSSUM_PATTERNS : toy === 'vacuglide' ? ['steady'] : PATTERNS;
  if (!allowedPatterns.includes(value.pattern)) throw new Error('Unsupported pattern');
  const channels = dual ? { percentA: Math.round(hasChannels ? value.percentA : value.percent), percentB: Math.round(hasChannels ? value.percentB : 0) } : {};
  const percent = dual ? Math.max(channels.percentA, channels.percentB) : Math.round(value.percent);
  return { percent, ...channels, pattern: value.pattern, ...recoveryFields, epoch: value.epoch, clientSeq: value.clientSeq };
}

export function sanitizeProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid profile');
  const output = { version: 1, savedAt: Number.isFinite(Number(value.savedAt)) ? Math.floor(Number(value.savedAt)) : Date.now(), calibration: {}, settings: {} };
  const calibration = value.calibration && typeof value.calibration === 'object' ? value.calibration : {};
  output.calibration = {
    mode: calibration.mode === 'automatic' ? 'automatic' : 'manual',
    zeroed: calibration.zeroed === true,
    complete: calibration.complete === true,
    step: typeof calibration.step === 'string' ? calibration.step.slice(0,20) : 'zero',
    autoSampleMs: Math.round(finite(Number(calibration.autoSampleMs),300,3000,1000)),
    status: typeof calibration.status === 'string' ? calibration.status.slice(0,240) : '',
    values: {},
  };
  for (const key of ['zero','relaxed','partial','full']) {
    const raw = calibration.values?.[key];
    const mean = Number(raw?.mean ?? raw);
    if (Number.isFinite(mean) && mean >= -327.6 && mean <= 327.6) output.calibration.values[key] = { mean: Math.round(mean*100)/100, std: finite(Number(raw?.std),0,100,0), range: finite(Number(raw?.range),0,200,0), samples: Math.round(finite(Number(raw?.samples),1,10000,1)) };
    else output.calibration.values[key] = null;
  }
  const s = value.settings && typeof value.settings === 'object' ? value.settings : {};
  const keys = ['threshold','resetThreshold','startPercent','rampSeconds','maxPercentA','maxPercentB','recoveryMinSeconds','recoveryMaxSeconds','shortPhaseSeconds','shortPhaseCount','stablePhaseSeconds','stablePhaseCount','adaptiveMaxMultiplier','patternSpeedSeconds','phaseOffset','patternMinA','patternMinB'];
  for (const key of keys) if (Number.isFinite(Number(s[key]))) output.settings[key] = Number(s[key]);
  output.settings.adaptiveEnabled = s.adaptiveEnabled !== false;
  if (['synchronized','alternating','offset-wave','pulse','custom'].includes(s.opossumPattern)) output.settings.opossumPattern = s.opossumPattern;
  if (JSON.stringify(output).length > 12000) throw new Error('Profile too large');
  return output;
}

export async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (v) => v.toString(16).padStart(2, '0')).join('');
}

export function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  while (code.length < 6) {
    const [byte] = crypto.getRandomValues(new Uint8Array(1));
    if (byte < Math.floor(256 / alphabet.length) * alphabet.length) code += alphabet[byte % alphabet.length];
  }
  return code;
}

export async function verifyPassword(password, settings) {
  if (typeof password !== 'string' || password.length < 1 || password.length > 256) return false;
  if (!settings || !/^(?:[a-f0-9]{2}){16,64}$/.test(settings.password_salt || '') || !/^[a-f0-9]{64}$/.test(settings.password_hash || '') || !Number.isInteger(settings.iterations) || settings.iterations < 600000 || settings.iterations > 1000000) return false;
  const salt = Uint8Array.from(settings.password_salt.match(/.{2}/g), (v) => parseInt(v, 16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: settings.iterations, salt }, key, 256));
  const expected = Uint8Array.from(settings.password_hash.match(/.{2}/g), (v) => parseInt(v, 16));
  let difference = derived.length ^ expected.length;
  for (let i = 0; i < derived.length; i++) difference |= derived[i] ^ expected[i];
  return difference === 0;
}

export function publicSession(row, best, now = Date.now()) {
  const state = sanitizeState(row.state, row.toy, row.simulation);
  const age = now - Date.parse(row.state_at);
  const fresh = Number.isFinite(age) && age >= 0 && age < 5000;
  if (!fresh) { state.phase = 'paused'; state.outputPercent = 0; state.outputPercentA = 0; state.outputPercentB = 0; state.reason = 'Host connection unavailable'; }
  return { sessionId: row.id, state, best: row.simulation ? 0 : best, hostOnline: fresh, serverNow: now, commandSeq: row.command_seq || 0, clientSeq: row.client_seq || 0 };
}

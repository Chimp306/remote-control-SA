/**
 * Elapsed session clock for the solo player.
 * Counts only while the engine is in play (`running`) or recovery
 * (`cooldown`). Paused, hidden-page pause, settling, fault and stopped
 * time is left out. The clock has no interval of its own: the host
 * calls sync() from the existing tick and from pause, resume, stop
 * and session start, so a second timer cannot double-count.
 */
const COUNTING_PHASES = new Set(['running', 'cooldown']);

export function formatPlayDuration(ms) {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const total = Math.floor(safe / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

export class PlayTimer {
  constructor() {
    this.elapsedMs = 0;
    this.segmentStartedAt = null;
  }

  reset() {
    this.elapsedMs = 0;
    this.segmentStartedAt = null;
  }

  /**
   * Fold the current phase into the accumulated total.
   * A repeated call at the same timestamp adds nothing.
   * A backwards timestamp does not increase the total.
   */
  sync(phase, now) {
    const at = Number(now);
    if (!Number.isFinite(at)) return this.elapsedMs;
    const counting = COUNTING_PHASES.has(phase);
    if (counting) {
      if (this.segmentStartedAt == null) this.segmentStartedAt = at;
    } else if (this.segmentStartedAt != null) {
      const delta = at - this.segmentStartedAt;
      if (delta > 0) this.elapsedMs += delta;
      this.segmentStartedAt = null;
    }
    return this.displayMs(at);
  }

  displayMs(now = this.segmentStartedAt) {
    if (this.segmentStartedAt == null || !Number.isFinite(Number(now))) return this.elapsedMs;
    const delta = Number(now) - this.segmentStartedAt;
    return this.elapsedMs + (delta > 0 ? delta : 0);
  }
}

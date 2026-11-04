/**
 * CTMP post-session report.
 *
 * Builds a display-only summary from recorded events. It never sends commands
 * to a toy and never changes the all-time personal best or edge counter.
 */
const validNumber = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const asSeconds = n => validNumber(n) ? Math.round(n * 10) / 10 : null;
export function buildFinishReport({ data, state, best = 0, simulation = false, endedAt = Date.now() } = {}) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.events)) {
    throw new TypeError('A recorded session is required for its finish report.');
  }
  const start = Date.parse(data.startedAt || '');
  const end = Date.parse(data.endedAt || '') || endedAt;
  const runtime = validNumber(data.runtimeSeconds)
    ? data.runtimeSeconds
    : Number.isFinite(start) ? Math.max(0, (end - start) / 1000) : 0;
  const count = Number.isSafeInteger(state?.edgeCount) && state.edgeCount >= 0
    ? state.edgeCount : 0;
  const bestCount = Number.isSafeInteger(best) && best >= 0 ? best : 0;
  const events = data.events.filter(event => event && event.type === 'cutoff');
  const lengths = events.map(event => event.cycleSeconds).filter(validNumber);
  const last = events.at(-1);
  const lastAt = last && Date.parse(last.at || '');
  const sinceLast = Number.isFinite(lastAt) && Number.isFinite(end) && end >= lastAt
    ? (end - lastAt) / 1000 : null;
  const totalCycles = lengths.reduce((sum, n) => sum + n, 0);
  const longCycle = lengths.length ? Math.max(...lengths) : null;
  const averageCycle = lengths.length ? totalCycles / lengths.length : null;
  let closingLine = 'Session complete. Your result is recorded, and your next game starts fresh.';
  if (count >= 100) closingLine = 'Triple figures. You kept going until you chose to finish. That one goes in the books.';
  else if (count >= 25) closingLine = 'That was quite a run. The counter tells the story — your next game starts from zero.';
  else if (count > 0) closingLine = 'You reached your finish line. Every edge from this session is in the record.';
  return {
    outcome: 'orgasm',
    simulation: Boolean(simulation),
    endedAt: Number.isFinite(end) ? new Date(end).toISOString() : null,
    durationSeconds: asSeconds(runtime) ?? 0,
    timeSinceLastEdgeSeconds: asSeconds(sinceLast),
    count,
    personalBest: bestCount,
    longestCycleSeconds: asSeconds(longCycle),
    averageCycleSeconds: asSeconds(averageCycle),
    cutoffEvents: events.length,
    closingLine,
  };
}

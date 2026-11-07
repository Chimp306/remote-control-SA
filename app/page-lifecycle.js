/**
 * What to do with live output when the browser changes page state.
 *
 * Chrome's Page Lifecycle API distinguishes a hidden page, which can keep
 * running, from a frozen or unloading page, whose tasks are about to stop:
 * https://developer.chrome.com/docs/web-platform/page-lifecycle-api
 * Hidden-tab timers are throttled, down to once a minute in the intensive
 * case, and that is not the same as a pause:
 * https://developer.chrome.com/blog/timer-throttling-in-chrome-88
 * Energy Saver freezing exempts a page that is using Web Bluetooth, but a
 * page can still be discarded from the hidden state with no further event:
 * https://developer.chrome.com/blog/freezing-on-energy-saver
 * https://developer.chrome.com/blog/memory-and-energy-saver-mode
 *
 * A normal tab switch is `visibilitychange` to hidden: keep the session.
 * `freeze` and `pagehide` mean this page will not keep watching the sensor,
 * so output stops. `resume` does not start it again; if the session is
 * somehow still marked running, stop it because the frozen interval was blind.
 */

export function lifecycleDecision({ type, stillRunning = false } = {}) {
  if (type === 'freeze' || type === 'pagehide') return 'stop';
  if (type === 'resume' && stillRunning) return 'stop';
  return 'continue';
}

/**
 * 100 ms clock. Dedicated-worker timers are less eager to sleep than a page
 * timer, and the page also holds a WebRTC keep-alive plus a quiet audio
 * context so Chrome does not clamp this interval when the tab is in the
 * background. The page performs the Bluetooth writes when these ticks arrive.
 */
let handle = 0;
let last = 0;

function tick() {
  const now = Date.now();
  const gap = last ? now - last : 0;
  last = now;
  postMessage({ now, gap });
}

onmessage = (event) => {
  if (event.data === 'start') {
    if (handle) return;
    last = 0;
    handle = setInterval(tick, 100);
    tick();
    return;
  }
  if (event.data === 'stop') {
    clearInterval(handle);
    handle = 0;
    last = 0;
  }
};

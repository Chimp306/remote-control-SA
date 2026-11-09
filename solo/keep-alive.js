/**
 * Keeps the tab's timers at full rate while a session is running.
 * Chrome clamps background timers (and a worker owned by that tab) unless
 * the page is playing audio or has a live WebRTC connection. The oscillator
 * sits at 19 kHz and a very low gain so it is not a tone Steve has to listen to.
 */

export function openKeepAlive() {
  const closers = [];
  try {
    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (AudioCtx) {
      const context = new AudioCtx();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 19000;
      gain.gain.value = 0.004;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      context.resume().catch(() => {});
      closers.push(() => {
        try { oscillator.stop(); } catch { /* already stopped */ }
        context.close().catch(() => {});
      });
    }
  } catch { /* a missing audio device should not block play */ }

  const webrtc = (async () => {
    const left = new RTCPeerConnection();
    const right = new RTCPeerConnection();
    closers.push(() => { left.close(); right.close(); });
    left.createDataChannel('solo');
    left.onicecandidate = (event) => { if (event.candidate) right.addIceCandidate(event.candidate).catch(() => {}); };
    right.onicecandidate = (event) => { if (event.candidate) left.addIceCandidate(event.candidate).catch(() => {}); };
    const offer = await left.createOffer();
    await left.setLocalDescription(offer);
    await right.setRemoteDescription(offer);
    const answer = await right.createAnswer();
    await right.setLocalDescription(answer);
    await left.setRemoteDescription(answer);
  })();
  webrtc.catch(() => {});

  return () => {
    while (closers.length) {
      try { closers.pop()(); } catch { /* closing is best-effort */ }
    }
  };
}

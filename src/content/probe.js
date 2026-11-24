// Tabtime page probe.
//
// Injected only when "Accurate tracking" is enabled and you have granted page
// access. It exists because the browser-process focus flag is unusable on
// Wayland: measured on this machine it read "nothing focused" for 13 minutes
// straight while a video was playing in the foreground.
//
// Two jobs:
//   1. Answer "does this page have focus right now?" -- document.hasFocus() is
//      decided by the renderer, a different mechanism from the window flag.
//   2. Push real media playback state, from the <video>/<audio> elements
//      themselves. That is exact, and unlike tab.audible it counts a MUTED
//      video and ignores audio that is not playback.
//
// It reads no page content, stores nothing, and sends nothing anywhere except
// this extension's own service worker.

const HEARTBEAT_MS = 15_000;
let beat = null;
// The top frame reports its state once on load, which clears a "playing" left
// behind by the previous page in this tab. Sub-frames (ads, embeds) start at
// "not playing" and speak only when that changes, so a page with a dozen
// iframes does not wake the service worker a dozen times on every load.
let lastReported = window === window.top ? null : false;

function playingNow() {
  return Array.from(document.querySelectorAll('video, audio')).some(
    (m) => !m.paused && !m.ended && m.readyState >= 2,
  );
}

function report(playing) {
  try {
    chrome.runtime.sendMessage({ type: 'media', playing });
  } catch { /* worker restarting, or extension reloaded */ }
}

function sync() {
  const playing = playingNow();

  if (playing !== lastReported) {
    lastReported = playing;
    report(playing);
  }

  // While playing, keep saying so: the worker treats a stale report as "not
  // playing", so a tab that goes away cannot leave the clock running.
  clearInterval(beat);
  beat = playing ? setInterval(() => report(playingNow()), HEARTBEAT_MS) : null;
}

// Media events do not bubble, so listen in the capture phase. This catches
// players added to the DOM later, and players inside iframes -- the script runs
// in every frame, and they all report against the same tab id.
for (const type of ['play', 'pause', 'ended', 'emptied', 'seeked', 'waiting', 'playing']) {
  document.addEventListener(type, sync, true);
}
document.addEventListener('visibilitychange', sync);

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.type !== 'tabtime-probe') return false;
  respond({
    hasFocus: document.hasFocus(),
    visible: document.visibilityState === 'visible',
    playing: playingNow(),
  });
  return false;
});

sync();

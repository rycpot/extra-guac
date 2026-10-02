// The built-in alert sound (refresh.sound = "chime"): a short two-note bell made with
// Web Audio, so nothing is downloaded. Used by offscreen.js and the settings "test" button.
function playChime() {
  const ctx = new AudioContext();
  const at = ctx.currentTime + 0.02;
  for (const [freq, start] of [[880, 0], [1318.5, 0.16]]) {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at + start);
    gain.gain.exponentialRampToValueAtTime(0.35, at + start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + start + 0.9);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at + start);
    osc.stop(at + start + 0.95);
  }
  return new Promise((resolve) => setTimeout(() => { ctx.close(); resolve(); }, 1200));
}

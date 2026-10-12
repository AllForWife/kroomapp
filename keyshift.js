// 🎼 升降 Key for the YouTube / Bilibili players (main.js 'embed-key'): the code below is put into the player's own frame (another site — the page
// cannot reach it, only the app can), where it takes the <video>'s sound into Web Audio and shifts its pitch without changing its speed.
// A phase vocoder (after Stephan Bernsee's smbPitchShift: 2048-point FFT, 4× overlap) per channel in a ScriptProcessorNode — no AudioWorklet module
// to load, so the players' content security rules do not get in the way. At 0 the sound goes straight through (no delay); shifted, it is late by
// LATENCY samples, which the page plays ahead by (src/music/stage.ts keyLead) so the music stays in step with the room and the singers.
// keyJs(n) is self-contained (it runs inside the frame); tests/keyshift-unit.mjs runs the same code in a plain page.

const FFT = 2048, OSAMP = 4, BUF = 2048;
/** how late the shifted sound is (samples): the FIFO (FFT − step) + one ScriptProcessor buffer */
const LATENCY = FFT - FFT / OSAMP + BUF;

const keyJs = (semis) => `(() => {
  const want = ${JSON.stringify(Math.max(-12, Math.min(12, Math.round(+semis || 0))))};
  const FFT = ${FFT}, OSAMP = ${OSAMP}, BUF = ${BUF}, LAT = ${LATENCY};
  const K = window.__kroomKey ||= { semis: 0, el: null, ctx: null, src: null, sp: null, gain: null, chans: [] };
  K.semis = want;
  const all = (root, out) => { for (const m of root.querySelectorAll('video, audio')) out.push(m); for (const e of root.querySelectorAll('*')) if (e.shadowRoot) all(e.shadowRoot, out); return out; };
  const own = (x) => /\\/bfs\\/static\\//.test(x.currentSrc || x.src || ''); // (Bilibili's own clips are not the song)
  const pick = () => { const l = all(document, []).filter((x) => !own(x)); return l.find((x) => x.tagName === 'VIDEO') || l[0] || null; };
  // one channel of the phase vocoder
  const chan = () => {
    const h = FFT / 2, step = FFT / OSAMP, lat = FFT - step;
    return { inF: new Float32Array(FFT), outF: new Float32Array(FFT), acc: new Float32Array(2 * FFT), lastPh: new Float32Array(h + 1), sumPh: new Float32Array(h + 1),
      re: new Float64Array(FFT), im: new Float64Array(FFT), aMag: new Float32Array(h + 1), aFrq: new Float32Array(h + 1), sMag: new Float32Array(h + 1), sFrq: new Float32Array(h + 1), rover: lat };
  };
  const win = new Float32Array(FFT); for (let k = 0; k < FFT; k++) win[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / FFT);
  const bits = Math.log2(FFT), rev = new Uint32Array(FFT); for (let i = 0; i < FFT; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cosT = new Float64Array(FFT / 2), sinT = new Float64Array(FFT / 2); for (let i = 0; i < FFT / 2; i++) { cosT[i] = Math.cos((2 * Math.PI * i) / FFT); sinT[i] = Math.sin((2 * Math.PI * i) / FFT); }
  const fft = (re, im, inv) => { // in place, radix 2
    for (let i = 0; i < FFT; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= FFT; size <<= 1) {
      const half = size >> 1, stepT = FFT / size;
      for (let i = 0; i < FFT; i += size) for (let j = 0, k = 0; j < half; j++, k += stepT) {
        const wr = cosT[k], wi = inv ? sinT[k] : -sinT[k], a = i + j, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  };
  const process = (c, input, output, ratio, sr) => {
    const h = FFT / 2, step = FFT / OSAMP, lat = FFT - step, perBin = sr / FFT, expct = (2 * Math.PI * step) / FFT;
    for (let i = 0; i < input.length; i++) {
      c.inF[c.rover] = input[i]; output[i] = c.outF[c.rover - lat]; c.rover++;
      if (c.rover < FFT) continue;
      c.rover = lat;
      const re = c.re, im = c.im;
      for (let k = 0; k < FFT; k++) { re[k] = c.inF[k] * win[k]; im[k] = 0; }
      fft(re, im, false);
      for (let k = 0; k <= h; k++) { // analysis: each bin's true frequency from its phase advance
        const mag = 2 * Math.hypot(re[k], im[k]), ph = Math.atan2(im[k], re[k]);
        let t = ph - c.lastPh[k]; c.lastPh[k] = ph; t -= k * expct;
        let q = Math.trunc(t / Math.PI); q += q >= 0 ? q & 1 : -(-q & 1); t -= Math.PI * q;
        c.aMag[k] = mag; c.aFrq[k] = k * perBin + ((OSAMP * t) / (2 * Math.PI)) * perBin;
      }
      c.sMag.fill(0); c.sFrq.fill(0);
      for (let k = 0; k <= h; k++) { const j = Math.floor(k * ratio); if (j <= h) { c.sMag[j] += c.aMag[k]; c.sFrq[j] = c.aFrq[k] * ratio; } }
      for (let k = 0; k <= h; k++) { // synthesis
        let t = (c.sFrq[k] - k * perBin) / perBin; t = (2 * Math.PI * t) / OSAMP + k * expct;
        c.sumPh[k] += t; const ph = c.sumPh[k];
        re[k] = c.sMag[k] * Math.cos(ph); im[k] = c.sMag[k] * Math.sin(ph);
      }
      for (let k = h + 1; k < FFT; k++) { re[k] = 0; im[k] = 0; }
      fft(re, im, true);
      for (let k = 0; k < FFT; k++) c.acc[k] += (2 * win[k] * re[k]) / (h * OSAMP);
      for (let k = 0; k < step; k++) c.outF[k] = c.acc[k];
      c.acc.copyWithin(0, step, step + FFT); c.acc.fill(0, FFT, 2 * FFT);
      c.inF.copyWithin(0, step, FFT);
    }
  };
  // the player's element, wired once (a media element can be taken into Web Audio only once; a new element — another video — is wired anew)
  const el = pick();
  if (el && el !== K.el && (want !== 0 || K.el)) {
    try {
      // always 48 kHz (Chromium resamples to the sound card): at the card's own rate — 96 / 192 kHz on many PCs — the 2048-point FFT was only 11 ms
      // long and the shifted key came out wrong (−3 Key: 359 Hz for 370), and it cost 4× the work
      const ctx = K.ctx ||= new AudioContext({ latencyHint: 'playback', sampleRate: 48000 });
      void ctx.resume();
      if (ctx.state !== 'running') { K.pending = true; } // (sound would stop: the element is left alone until the context runs — next call)
      else {
        const src = ctx.createMediaElementSource(el), sp = ctx.createScriptProcessor(BUF, 2, 2), gain = ctx.createGain();
        K.el = el; K.src = src; K.sp = sp; K.gain = gain; K.chans = [chan(), chan()]; K.pending = false;
        sp.onaudioprocess = (e) => {
          const r = Math.pow(2, K.semis / 12), sr = ctx.sampleRate;
          for (let ch = 0; ch < e.outputBuffer.numberOfChannels; ch++) {
            const inp = e.inputBuffer.getChannelData(Math.min(ch, e.inputBuffer.numberOfChannels - 1)), out = e.outputBuffer.getChannelData(ch);
            process(K.chans[ch] ||= chan(), inp, out, r, sr);
          }
        };
        gain.connect(ctx.destination);
      }
    } catch (e) { K.error = String(e && e.message || e); }
  }
  // the route: straight through at 0 (no delay), through the shifter otherwise
  if (K.src) {
    const shifted = K.semis !== 0;
    if (K.route !== shifted) {
      try { K.src.disconnect(); K.sp.disconnect(); } catch {}
      if (shifted) { K.chans = [chan(), chan()]; K.src.connect(K.sp); K.sp.connect(K.gain); } else K.src.connect(K.gain);
      K.route = shifted;
    }
    if (K.ctx.state !== 'running') void K.ctx.resume();
  }
  return { semis: K.semis, wired: !!K.src, shifting: !!K.src && K.semis !== 0, latency: K.src && K.semis !== 0 ? LAT / K.ctx.sampleRate : 0, pending: !!K.pending, error: K.error || '' };
})()`;

module.exports = { keyJs, LATENCY };

// 🎼 升降 Key for the YouTube / Bilibili players (main.js 'embed-key'): the code below is put into the player's own frame (another site — the page
// cannot reach it, only the app can), where it takes the <video>'s sound into Web Audio and shifts its pitch without changing its speed.
//
// The shifter (makeShifter) is a phase vocoder that STRETCHES the sound in time (frames taken every Ra samples, laid down every Rs = ratio × Ra) and
// then plays the stretched sound back faster by the same ratio (cubic resampling): the length is the song's again, every frequency × ratio exactly.
// Its phases are locked to the spectrum's peaks (Laroche & Dolson's identity phase locking): the bins around a peak keep their phase relation to it,
// so a note stays one note. The first version moved every bin on its own (smbPitchShift) — on real music that sounds metallic and phasey (「電電的」).
//
// It runs in an AudioWorklet — on the audio thread: the first version ran in a ScriptProcessor on the player frame's main thread, and whenever
// YouTube's own page was busy the sound broke up (stuttered), and it needed two 2048-sample buffers (117 ms late). A worklet module cannot be
// loaded from a page or a data: URL past the players' content security rules, so the app serves it itself (main.js: kroomfx://, a scheme that
// bypasses them); a ScriptProcessor running the same shifter is the fallback where the module cannot load.
// At 0 the sound goes straight through (no delay); shifted, it is late by latencyOf() — the page plays ahead by that (src/music/stage.ts keyLead)
// so the music stays in step with the room and the singers. keyJs(n, moduleUrl) is self-contained (it runs inside the frame);
// tests/keyshift-core-unit.mjs runs the shifter itself, tests/keyshift-unit.mjs / keyshift-latency-unit.mjs the whole route in a plain page.

const N = 2048, RA = 512, PREFILL = 64, SP_BUF = 2048;

/** one channel's pitch shifter: process(input, output, ratio) — sample in, sample out, a fixed delay (latencyOf) */
function makeShifter(N, Ra, prefill) {
  const h = N / 2, TWO_PI = 2 * Math.PI;
  const win = new Float32Array(N); for (let k = 0; k < N; k++) win[k] = 0.5 - 0.5 * Math.cos((TWO_PI * k) / N);
  const bits = Math.log2(N), rev = new Uint32Array(N); for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cosT = new Float64Array(h), sinT = new Float64Array(h); for (let i = 0; i < h; i++) { cosT[i] = Math.cos((TWO_PI * i) / N); sinT[i] = Math.sin((TWO_PI * i) / N); }
  const fft = (re, im, inv) => { // in place, radix 2
    for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, stepT = N / size;
      for (let i = 0; i < N; i += size) for (let j = 0, k = 0; j < half; j++, k += stepT) {
        const wr = cosT[k], wi = inv ? sinT[k] : -sinT[k], a = i + j, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  };
  const inBuf = new Float32Array(N); let fill = 0;
  const re = new Float64Array(N), im = new Float64Array(N);
  const mag = new Float32Array(h + 1), phA = new Float32Array(h + 1), prevPhA = new Float32Array(h + 1), phS = new Float64Array(h + 1), prevPhS = new Float64Array(h + 1);
  const peaks = new Int32Array(h + 1);
  // the stretched sound: overlap-added frames and their summed window² (each sample is divided by it), a ring on an absolute timeline
  const RING = 8 * N, ola = new Float32Array(RING), wsum = new Float32Array(RING);
  let P = 0, rp = 0, cleared = 0, first = true;
  // the finished output, played out one sample per input sample (after `prefill` samples are ready: the frames come in bursts)
  const Q = 4 * N, outQ = new Float32Array(Q); let qHead = 0, qLen = 0, wait = -1;
  const self = { underruns: 0 }; // (samples the queue ran dry after the start: a click — the prefill keeps it at 0)
  const at = (s) => { const i = s % RING, w = wsum[i]; return w > 1e-3 ? ola[i] / w : 0; };
  const frame = (ratio) => {
    const Rs = Math.max(1, Math.round(Ra * ratio)), alpha = Rs / Ra;
    for (let k = 0; k < N; k++) { re[k] = inBuf[k] * win[k]; im[k] = 0; }
    fft(re, im, false);
    let maxM = 0;
    for (let k = 0; k <= h; k++) { const m = Math.hypot(re[k], im[k]); mag[k] = m; phA[k] = Math.atan2(im[k], re[k]); if (m > maxM) maxM = m; }
    if (first) { for (let k = 0; k <= h; k++) phS[k] = phA[k]; first = false; }
    else {
      // the peaks (local maxima over ±2 bins, above −80 dB of the loudest)
      let np = 0; const thr = maxM * 1e-4;
      for (let k = 1; k < h; k++) { const m = mag[k]; if (m > thr && m > mag[k - 1] && m >= mag[k + 1] && (k < 2 || m > mag[k - 2]) && (k + 2 > h || m >= mag[k + 2])) peaks[np++] = k; }
      const adv = (k) => { let d = phA[k] - prevPhA[k] - (TWO_PI * k * Ra) / N; d -= TWO_PI * Math.round(d / TWO_PI); return ((TWO_PI * k) / N + d / Ra) * Rs; };
      if (!np) for (let k = 0; k <= h; k++) phS[k] = prevPhS[k] + adv(k);
      else for (let i = 0; i < np; i++) {
        // the peak's phase moves on by its own frequency × Rs; the bins in its region keep their analysis phase relation to it
        const kp = peaks[i], ps = prevPhS[kp] + adv(kp);
        const lo = i === 0 ? 0 : ((peaks[i - 1] + kp) >> 1) + 1, hi = i === np - 1 ? h : (kp + peaks[i + 1]) >> 1;
        for (let k = lo; k <= hi; k++) phS[k] = ps + (phA[k] - phA[kp]);
      }
    }
    for (let k = 0; k <= h; k++) { const p = phS[k] - TWO_PI * Math.round(phS[k] / TWO_PI); phS[k] = p; prevPhS[k] = p; prevPhA[k] = phA[k]; re[k] = mag[k] * Math.cos(p); im[k] = mag[k] * Math.sin(p); }
    im[0] = 0; im[h] = 0; for (let k = h + 1; k < N; k++) { re[k] = re[N - k]; im[k] = -im[N - k]; }
    fft(re, im, true);
    for (let k = 0; k < N; k++) { const i = (P + k) % RING; ola[i] += (re[k] / N) * win[k]; wsum[i] += win[k] * win[k]; }
    P += Rs; // (everything before P is final: the next frame starts there)
    // play the stretched sound back `alpha` times as fast (Catmull-Rom): Ra new samples for every frame
    while (rp + 2 < P && qLen < Q) {
      const s = Math.floor(rp), t = rp - s, y0 = at(s - 1 < 0 ? 0 : s - 1), y1 = at(s), y2 = at(s + 1), y3 = at(s + 2);
      outQ[(qHead + qLen) % Q] = y1 + 0.5 * t * (y2 - y0 + t * (2 * y0 - 5 * y1 + 4 * y2 - y3 + t * (3 * (y1 - y2) + y3 - y0)));
      qLen++; rp += alpha;
    }
    for (const end = Math.floor(rp) - 2; cleared < end; cleared++) { const i = cleared % RING; ola[i] = 0; wsum[i] = 0; } // (read: room for the next)
  };
  self.process = (input, output, ratio) => {
    for (let n = 0; n < input.length; n++) {
      inBuf[fill++] = input[n];
      if (fill === N) { frame(ratio); inBuf.copyWithin(0, Ra, N); fill = N - Ra; if (wait < 0) wait = prefill; }
      // the frames come in bursts of ~Ra samples: the output starts `prefill` samples after the first one, so the queue never runs dry just
      // before the next burst (a one-sample gap is a click)
      if (wait > 0) { wait--; output[n] = 0; continue; }
      if (wait === 0 && qLen) { output[n] = outQ[qHead]; qHead = (qHead + 1) % Q; qLen--; } else { output[n] = 0; if (wait === 0) self.underruns++; }
    }
  };
  return self;
}
/** how late the shifted sound is (samples) at this ratio: the first frame (N) + the prefill + the resampler's lead (2), and the stretched frames'
 *  centres move by N/2 × (1/ratio − 1) — checked against the real delay in tests/keyshift-core-unit.mjs */
const latencyOf = (ratio) => N + PREFILL + 2 + (N / 2) * (1 / ratio - 1);

/** the AudioWorklet module (main.js serves it at kroomfx://app/keyshift-worklet.js) */
const WORKLET = `${makeShifter.toString()}
class KroomKeyShift extends AudioWorkletProcessor {
  constructor() { super(); this.semis = 0; this.sh = []; this.port.onmessage = (e) => { const d = e.data || {}; if (typeof d.semis === 'number') this.semis = d.semis; if (d.reset) this.sh = []; }; }
  process(inputs, outputs) {
    const inp = inputs[0] || [], out = outputs[0], r = Math.pow(2, this.semis / 12);
    for (let c = 0; c < out.length; c++) { const x = inp[c] || inp[0]; if (!x) { out[c].fill(0); continue; } (this.sh[c] ||= makeShifter(${N}, ${RA}, ${PREFILL})).process(x, out[c], r); }
    return true;
  }
}
registerProcessor('kroom-keyshift', KroomKeyShift);`;

const keyJs = (semis, moduleUrl = '') => `(() => {
  const want = ${JSON.stringify(Math.max(-12, Math.min(12, Math.round(+semis || 0))))};
  const MODULE = ${JSON.stringify(String(moduleUrl || ''))}; // (no module: the ScriptProcessor fallback — the iOS app, ios/gen-scripts.mjs)
  const K = window.__kroomKey ||= { semis: 0, el: null, ctx: null, src: null, fx: null, gain: null, kind: '' };
  K.semis = want;
  const all = (root, out) => { for (const m of root.querySelectorAll('video, audio')) out.push(m); for (const e of root.querySelectorAll('*')) if (e.shadowRoot) all(e.shadowRoot, out); return out; };
  const own = (x) => /\\/bfs\\/static\\//.test(x.currentSrc || x.src || ''); // (Bilibili's own clips are not the song)
  const pick = () => { const l = all(document, []).filter((x) => !own(x)); return l.find((x) => x.tagName === 'VIDEO') || l[0] || null; };
  const makeShifter = ${makeShifter.toString()};
  // the player's element, wired once (a media element can be taken into Web Audio only once; a new element — another video — is wired anew)
  const el = pick();
  if (el && el !== K.el && (want !== 0 || K.el)) {
    try {
      // always 48 kHz (Chromium resamples to the sound card): at the card's own rate — 96 / 192 kHz on many PCs — the FFT was only 11 ms long and the
      // key came out wrong, at 4× the work. 'interactive': the smallest output buffer (once wired the sound stays in Web Audio even at 原調)
      const ctx = K.ctx ||= new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
      void ctx.resume();
      // the worklet module first (once): the shifter on the audio thread; until it is in, nothing is wired (the page asks again in 2 s)
      if (MODULE && ctx.audioWorklet && !K.mod) { K.mod = 'loading'; ctx.audioWorklet.addModule(MODULE).then(() => { K.mod = 'ok'; }, (e) => { K.mod = 'fail'; K.error = 'worklet: ' + String(e && e.message || e); }); }
      if (ctx.state !== 'running' || K.mod === 'loading') { K.pending = true; } // (sound would stop: the element is left alone until the context runs — next call)
      else {
        const src = ctx.createMediaElementSource(el), gain = ctx.createGain();
        let fx;
        if (K.mod === 'ok') { fx = new AudioWorkletNode(ctx, 'kroom-keyshift', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' }); K.kind = 'worklet'; }
        else { // the fallback: the same shifter in a ScriptProcessor (on this frame's main thread)
          fx = ctx.createScriptProcessor(${SP_BUF}, 2, 2); K.kind = 'script'; K.sh = [];
          fx.onaudioprocess = (e) => { const r = Math.pow(2, K.semis / 12); for (let c = 0; c < e.outputBuffer.numberOfChannels; c++) (K.sh[c] ||= makeShifter(${N}, ${RA}, ${PREFILL})).process(e.inputBuffer.getChannelData(Math.min(c, e.inputBuffer.numberOfChannels - 1)), e.outputBuffer.getChannelData(c), r); };
        }
        K.el = el; K.src = src; K.fx = fx; K.gain = gain; K.pending = false; K.route = undefined;
        gain.connect(ctx.destination);
      }
    } catch (e) { K.error = String(e && e.message || e); }
  }
  // the route: straight through at 0 (no delay), through the shifter otherwise
  if (K.src) {
    const shifted = K.semis !== 0;
    if (K.kind === 'worklet') K.fx.port.postMessage({ semis: K.semis });
    if (K.route !== shifted) {
      try { K.src.disconnect(); K.fx.disconnect(); } catch {}
      if (shifted) { if (K.kind === 'worklet') K.fx.port.postMessage({ reset: true, semis: K.semis }); else K.sh = []; K.src.connect(K.fx); K.fx.connect(K.gain); } else K.src.connect(K.gain);
      K.route = shifted;
    }
    if (K.ctx.state !== 'running') void K.ctx.resume();
  }
  const r = Math.pow(2, K.semis / 12), lat = ${N} + ${PREFILL} + 2 + (${N} / 2) * (1 / r - 1) + (K.kind === 'script' ? 2 * ${SP_BUF} : 0);
  return { semis: K.semis, wired: !!K.src, shifting: !!K.src && K.semis !== 0, kind: K.kind || '', latency: K.src && K.semis !== 0 ? lat / K.ctx.sampleRate : 0, pending: !!K.pending, error: K.error || '' };
})()`;

module.exports = { keyJs, makeShifter, latencyOf, WORKLET, N, RA, PREFILL };

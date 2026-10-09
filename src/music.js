/*
 * music.js
 *
 * Slow generative ambient music, synthesized live with the Web Audio API.
 * No audio files. Exposes window.SquishyMusic.create().
 *
 *   pads    four-chord loop in D (Dmaj9, Bm11, Gmaj9#11, A6/9), detuned
 *           saw + triangle through a slowly opening low-pass, 11 s per chord
 *   chimes  sparse bell tones from D major pentatonic, sometimes a short run
 *   air     brown noise through a drifting band-pass, like slow breathing
 *
 * Everything shares one convolution reverb built from decaying noise.
 * Browsers only allow audio to start from a click, tap or key press, so
 * start() must be called from an input handler.
 */
(function (root) {
  'use strict';

  const AC = root.AudioContext || root.webkitAudioContext;
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const CHORD_SECONDS = 11;
  const CHORDS = [
    { root: 38, notes: [50, 57, 61, 64, 66] }, // Dmaj9
    { root: 35, notes: [47, 54, 57, 62, 64] }, // Bm11
    { root: 31, notes: [43, 50, 54, 57, 61] }, // Gmaj9#11
    { root: 33, notes: [45, 52, 59, 61, 66] }, // A6/9
  ];
  const CHIMES = [74, 76, 78, 81, 83, 86, 88, 90, 93]; // D E F# A B, D5 to A6

  function create() {
    let ctx = null;
    let master, dry, wet;
    let playing = false;
    let volume = 0.5;
    let timer = 0;
    let suspendTimer = 0;
    let nextChord = 0, chordIndex = 0, nextChime = 0;

    const level = (v) => v * v * 0.9; // perceptual taper

    function impulse(seconds, decay) {
      const rate = ctx.sampleRate;
      const len = Math.floor(rate * seconds);
      const buf = ctx.createBuffer(2, len, rate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
      return buf;
    }

    function panner(value) {
      if (!ctx.createStereoPanner) return null;
      const p = ctx.createStereoPanner();
      p.pan.value = value;
      return p;
    }

    function build() {
      ctx = new AC({ latencyHint: 'playback' });
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -20;
      comp.knee.value = 12;
      comp.ratio.value = 3;
      comp.attack.value = 0.05;
      comp.release.value = 0.5;
      master = ctx.createGain();
      master.gain.value = 0;
      comp.connect(master);
      master.connect(ctx.destination);

      dry = ctx.createGain();
      dry.gain.value = 0.7;
      dry.connect(comp);
      const verb = ctx.createConvolver();
      verb.buffer = impulse(5.5, 2.6);
      wet = ctx.createGain();
      wet.gain.value = 0.55;
      wet.connect(verb);
      verb.connect(comp);

      startAir();
      nextChord = ctx.currentTime + 0.05;
      nextChime = ctx.currentTime + 2.5;
    }

    function startAir() {
      const rate = ctx.sampleRate;
      const len = rate * 4;
      const buf = ctx.createBuffer(1, len, rate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; // brown noise
        d[i] = last * 3.5;
      }
      // fade the loop seam
      for (let i = 0; i < 2048; i++) {
        const k = i / 2048;
        d[i] *= k; d[len - 1 - i] *= k;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 650;
      bp.Q.value = 0.5;
      const sweep = ctx.createOscillator();
      sweep.frequency.value = 0.045;
      const sweepDepth = ctx.createGain();
      sweepDepth.gain.value = 300;
      sweep.connect(sweepDepth);
      sweepDepth.connect(bp.frequency);
      const g = ctx.createGain();
      g.gain.value = 0.02;
      const breath = ctx.createOscillator();
      breath.frequency.value = 0.075;
      const breathDepth = ctx.createGain();
      breathDepth.gain.value = 0.012;
      breath.connect(breathDepth);
      breathDepth.connect(g.gain);
      src.connect(bp);
      bp.connect(g);
      g.connect(dry);
      g.connect(wet);
      src.start();
      sweep.start();
      breath.start();
    }

    function playChord(chord, t, hold) {
      const attack = 3.5, release = 5;
      const end = t + hold + release + 0.1;
      const bus = ctx.createGain();
      bus.gain.setValueAtTime(0, t);
      bus.gain.linearRampToValueAtTime(1, t + attack);
      bus.gain.setValueAtTime(1, t + hold);
      bus.gain.linearRampToValueAtTime(0, t + hold + release);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.6;
      lp.frequency.setValueAtTime(480, t);
      lp.frequency.linearRampToValueAtTime(1100 + Math.random() * 600, t + hold * 0.55);
      lp.frequency.linearRampToValueAtTime(560, t + hold + release);
      bus.connect(lp);
      lp.connect(dry);
      lp.connect(wet);

      const nodes = [bus, lp];
      let lastOsc = null;
      const voice = (type, freq, cents, gain, pan) => {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = freq;
        o.detune.value = cents;
        const g = ctx.createGain();
        g.gain.value = gain;
        o.connect(g);
        const p = panner(pan);
        if (p) { g.connect(p); p.connect(bus); nodes.push(p); } else g.connect(bus);
        nodes.push(o, g);
        o.start(t);
        o.stop(end);
        lastOsc = o;
      };
      const n = chord.notes.length;
      chord.notes.forEach((m, i) => {
        const spread = (i / (n - 1) - 0.5) * 0.7;
        voice('sawtooth', mtof(m), -7 + (Math.random() - 0.5) * 4, 0.016, -spread);
        voice('triangle', mtof(m), 6 + (Math.random() - 0.5) * 4, 0.034, spread);
      });
      voice('sine', mtof(chord.root), 0, 0.09, 0);
      lastOsc.onended = () => nodes.forEach((x) => x.disconnect());
    }

    function chime(t, m) {
      const f = mtof(m);
      const decay = 2.8 + Math.random() * 1.6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.045, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0005, t + decay);
      const g2 = ctx.createGain(); // inharmonic partial gives the glassy edge
      g2.gain.setValueAtTime(0, t);
      g2.gain.linearRampToValueAtTime(0.012, t + 0.005);
      g2.gain.exponentialRampToValueAtTime(0.0003, t + decay * 0.35);
      const o1 = ctx.createOscillator();
      o1.type = 'sine';
      o1.frequency.value = f;
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = f * 2.76;
      o1.connect(g);
      o2.connect(g2);
      const out = panner((Math.random() - 0.5) * 1.4);
      const dest = out || ctx.createGain();
      g.connect(dest);
      g2.connect(dest);
      const dryShare = ctx.createGain();
      dryShare.gain.value = 0.45;
      dest.connect(dryShare);
      dryShare.connect(dry);
      dest.connect(wet);
      o1.start(t); o2.start(t);
      o1.stop(t + decay + 0.1); o2.stop(t + decay + 0.1);
      o1.onended = () => [o1, o2, g, g2, dest, dryShare].forEach((x) => x.disconnect());
    }

    function chimeGroup(t) {
      const start = Math.floor(Math.random() * CHIMES.length);
      const count = Math.random() < 0.22 ? 2 + Math.floor(Math.random() * 2) : 1;
      for (let i = 0; i < count; i++) {
        const m = CHIMES[Math.min(CHIMES.length - 1, start + i * (1 + Math.floor(Math.random() * 2)))];
        chime(t + i * (0.16 + Math.random() * 0.1), m);
      }
    }

    // Schedule a few seconds ahead on the audio clock. Background tabs throttle
    // timers to about 1 s, so the lookahead has to be longer than that.
    function tick() {
      const ahead = ctx.currentTime + 3;
      while (nextChord < ahead) {
        playChord(CHORDS[chordIndex % CHORDS.length], nextChord, CHORD_SECONDS);
        chordIndex++;
        nextChord += CHORD_SECONDS;
      }
      while (nextChime < ahead) {
        chimeGroup(nextChime);
        nextChime += 1.4 + Math.random() * 3.6;
      }
    }

    function start() {
      if (!AC) return false;
      if (!ctx) build();
      // iOS: play even with the ring/silent switch on, like other media
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* not supported */ }
      clearTimeout(suspendTimer);
      if (ctx.state !== 'running') ctx.resume();
      playing = true;
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setTargetAtTime(level(volume), ctx.currentTime, 0.6);
      tick();
      clearInterval(timer);
      timer = setInterval(tick, 400);
      return true;
    }

    function pause() {
      if (!ctx || !playing) return;
      playing = false;
      clearInterval(timer);
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
      suspendTimer = setTimeout(() => { if (!playing && ctx.state === 'running') ctx.suspend(); }, 1500);
    }

    function setVolume(v) {
      volume = Math.min(1, Math.max(0, v));
      if (ctx && playing) master.gain.setTargetAtTime(level(volume), ctx.currentTime, 0.08);
    }

    return {
      supported: !!AC,
      start,
      pause,
      toggle() { if (playing) pause(); else start(); return playing; },
      setVolume,
      get playing() { return playing; },
      get volume() { return volume; },
    };
  }

  root.SquishyMusic = { create };
})(typeof self !== 'undefined' ? self : this);

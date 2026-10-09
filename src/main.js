/*
 * main.js
 *
 * Scene, materials and pointer interaction for the cube squishy.
 * Needs three.js r149 (UMD build, window.THREE) and src/softbody.js.
 */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const statusEl = $('#status');
  function fail(msg) {
    statusEl.textContent = msg;
    statusEl.hidden = false;
  }

  const THREE = window.THREE;
  if (!THREE) return fail('three.js did not load. Check your connection, then reload the page.');
  if (!window.SquishyPhysics) return fail('src/softbody.js did not load. Serve the folder or open index.html from the repo root.');
  const { SoftBody, sdRoundBox, FEEL_PRESETS } = window.SquishyPhysics;

  const clamp = THREE.MathUtils.clamp;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------------ config
  // 1 scene unit is roughly 1.5 cm, so the cube is about 3 cm across.
  const HALF = 1;
  const CORNER = 0.3;
  // warm key light, off camera to the right and slightly behind the cube
  const LAMP = { x: 3.3, z: -1.4 };
  const LAMP_POS = new THREE.Vector3(LAMP.x, 2.2, LAMP.z);

  // --------------------------------------------------------------- renderer
  const canvas = $('#scene');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    return fail('WebGL is turned off or not supported in this browser, so the squishy cannot render.');
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.physicallyCorrectLights = true;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  // black fog melts the floor into the background well behind the cube
  scene.fog = new THREE.Fog(0x000000, 11, 24);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 100);

  // ------------------------------------------------------- procedural noise
  function hash2(x, y, s) {
    let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  // value noise, periodic over (px, py) cells so textures tile
  function vnoise(x, y, px, py, s) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const x0 = ((xi % px) + px) % px, x1 = (x0 + 1) % px;
    const y0 = ((yi % py) + py) % py, y1 = (y0 + 1) % py;
    const a = hash2(x0, y0, s), b = hash2(x1, y0, s), c = hash2(x0, y1, s), d = hash2(x1, y1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, px, py, s, oct) {
    let sum = 0, amp = 0.5, f = 1, norm = 0;
    for (let o = 0; o < oct; o++) {
      sum += amp * vnoise(x * f, y * f, px * f, py * f, s + o * 17);
      norm += amp; amp *= 0.5; f *= 2;
    }
    return sum / norm;
  }
  function hash3(x, y, z, s) {
    return hash2(Math.imul(x | 0, 73856093) ^ (z | 0) * 19349663, y, s);
  }
  function noise3(x, y, z, s) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
    const l = (a, b, t) => a + (b - a) * t;
    const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz, s);
    return l(
      l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
      l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
      w
    );
  }
  function mulberry32(a) {
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  function canvas2d(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  function heightToNormal(height, S, strength) {
    const c = canvas2d(S, S);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(S, S);
    const at = (x, y) => height[((y + S) % S) * S + ((x + S) % S)];
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
        const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
        const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
        const o = 4 * (y * S + x);
        img.data[o] = (-dx * inv * 0.5 + 0.5) * 255;
        img.data[o + 1] = (dy * inv * 0.5 + 0.5) * 255;
        img.data[o + 2] = (inv * 0.5 + 0.5) * 255;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }
  function tex(c, srgb, repeat) {
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.encoding = THREE.sRGBEncoding;
    t.anisotropy = maxAniso;
    if (repeat) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat[0], repeat[1]);
    }
    return t;
  }

  // ---------------------------------------------------------------- textures
  // fine mottling, dust specks and hairline scratches on the jelly skin
  function makeJellySkin() {
    const S = 512;
    const h = canvas2d(S, S);
    const ctx = h.getContext('2d');
    const img = ctx.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const n = fbm(x / S * 6, y / S * 6, 6, 6, 41, 4);
        const g = 110 + (n - 0.5) * 50;
        const o = 4 * (y * S + x);
        img.data[o] = img.data[o + 1] = img.data[o + 2] = g;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const rnd = mulberry32(77);
    for (let i = 0; i < 700; i++) {
      ctx.fillStyle = `rgba(255,255,255,${0.25 + rnd() * 0.6})`;
      ctx.beginPath();
      ctx.arc(rnd() * S, rnd() * S, 0.4 + Math.pow(rnd(), 3) * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 45; i++) {
      ctx.strokeStyle = `rgba(255,255,255,${0.12 + rnd() * 0.25})`;
      ctx.lineWidth = 0.5 + rnd() * 0.8;
      const x = rnd() * S, y = rnd() * S, len = 15 + rnd() * 70, a = rnd() * Math.PI;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + Math.cos(a + 0.4) * len * 0.5, y + Math.sin(a + 0.4) * len * 0.5, x + Math.cos(a) * len, y + Math.sin(a) * len);
      ctx.stroke();
    }
    const data = ctx.getImageData(0, 0, S, S).data;
    const height = new Float32Array(S * S);
    const rough = canvas2d(S, S);
    const rctx = rough.getContext('2d');
    const rimg = rctx.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
      const v = data[4 * i] / 255;
      height[i] = v;
      // base ~0.3 of material roughness, specks and scratches go matte
      const r = clamp(0.28 + Math.max(0, v - 0.47) * 1.6, 0, 1) * 255;
      rimg.data[4 * i] = rimg.data[4 * i + 1] = rimg.data[4 * i + 2] = r;
      rimg.data[4 * i + 3] = 255;
    }
    rctx.putImageData(rimg, 0, 0);
    return { normalMap: tex(heightToNormal(height, S, 2.2), false), roughnessMap: tex(rough, false) };
  }

  // tiny facets with random normals: reads as packed glitter on the core
  function makeSparkleNormal() {
    const S = 512;
    const c = canvas2d(S, S);
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgb(128,128,255)';
    ctx.fillRect(0, 0, S, S);
    const rnd = mulberry32(11);
    for (let i = 0; i < 5200; i++) {
      const x = rnd() * S, y = rnd() * S, r = 2 + rnd() * 4.5, a0 = rnd() * Math.PI;
      const tx = (rnd() - 0.5) * 1.6, ty = (rnd() - 0.5) * 1.6;
      const inv = 1 / Math.sqrt(tx * tx + ty * ty + 1);
      ctx.fillStyle = `rgb(${(tx * inv * 0.5 + 0.5) * 255 | 0},${(ty * inv * 0.5 + 0.5) * 255 | 0},${(inv * 0.5 + 0.5) * 255 | 0})`;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = a0 + (k * Math.PI) / 3;
        k ? ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r) : ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      }
      ctx.fill();
    }
    return tex(c, false);
  }

  // soft rounded-square alpha for contact shadow and caustic
  function makeSoftSquare(S, inner, feather) {
    const c = canvas2d(S, S);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const px = (x + 0.5) / S * 2 - 1, py = (y + 0.5) / S * 2 - 1;
        const qx = Math.abs(px) - inner, qy = Math.abs(py) - inner;
        const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
        const a = 1 - smoothstep(-feather * 0.15, feather, d);
        const o = 4 * (y * S + x);
        img.data[o] = img.data[o + 1] = img.data[o + 2] = a * a * 255;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return tex(c, false);
  }

  function makeRadial(S, stops) {
    const c = canvas2d(S, S);
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    for (const [o, col] of stops) g.addColorStop(o, col);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    return tex(c, true);
  }

  // ------------------------------------------------- environment / studio
  // Reflections come from a black studio with a few soft light panels: a
  // warm strip where the key light is, a softbox overhead and a faint fill.
  function buildEnvironment() {
    const env = new THREE.Scene();
    env.background = new THREE.Color(0x000000);
    const basic = (r, g, b) => new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b), side: THREE.DoubleSide });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), basic(0.012, 0.012, 0.012));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.01;
    env.add(floor);
    const strip = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 3.0, 6, 16), basic(14, 10.5, 7.2));
    strip.position.set(LAMP_POS.x, LAMP_POS.y - 1, LAMP_POS.z);
    env.add(strip);
    const top = new THREE.Mesh(new THREE.PlaneGeometry(5, 5), basic(1.6, 1.6, 1.65));
    top.rotation.x = Math.PI / 2;
    top.position.set(0, 7, 0.5);
    env.add(top);
    const front = new THREE.Mesh(new THREE.PlaneGeometry(8, 3), basic(0.22, 0.23, 0.25));
    front.position.set(-2, 2.5, 10);
    front.rotation.y = Math.PI;
    env.add(front);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromScene(env, 0.03);
    pmrem.dispose();
    return rt.texture;
  }

  scene.environment = buildEnvironment();

  // Floor: dark, slightly satin, with a faint mottled sheen. It is lit only
  // around the cube and fades to black, so it grounds the cube without
  // reading as any particular surface.
  function makeFloorRoughness() {
    const S = 256;
    const c = canvas2d(S, S);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const n = fbm(x / S * 8, y / S * 8, 8, 8, 61, 4);
        const v = clamp(0.55 + (n - 0.5) * 0.7, 0, 1) * 255;
        const o = 4 * (y * S + x);
        img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return tex(c, false, [10, 10]);
  }
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(30, 128),
    new THREE.MeshStandardMaterial({
      color: 0x404044,
      map: makeRadial(512, [[0, '#ffffff'], [0.12, '#d0d0d0'], [0.3, '#5a5a5a'], [0.6, '#141414'], [1, '#000000']]),
      roughness: 0.62,
      roughnessMap: makeFloorRoughness(),
      metalness: 0,
      envMapIntensity: 0.35,
    })
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // warm key from the right and behind (this is what makes the jelly glow)
  const lampLight = new THREE.PointLight(0xffd3a1, 46, 0, 2);
  lampLight.position.copy(LAMP_POS).add(new THREE.Vector3(-0.55, 0, 0.35));
  scene.add(lampLight);
  // soft neutral pool from above so the cube sits in its own light
  const topLight = new THREE.SpotLight(0xf4f1ec, 70, 0, 0.42, 1, 2);
  topLight.position.set(0, 7, 0.5);
  topLight.target.position.set(0, 0, 0);
  scene.add(topLight, topLight.target);
  const fill = new THREE.HemisphereLight(0xc8ccd4, 0x141210, 0.35);
  scene.add(fill);
  const rim = new THREE.PointLight(0xffc799, 6, 0, 2);
  rim.position.set(-2.5, 3.2, -3.4);
  scene.add(rim);

  // ----------------------------------------------------------- soft body
  const sb = new SoftBody({
    resolution: 10,
    halfSize: HALF,
    cornerRadius: CORNER,
    home: [0, HALF, 0],
    box: { minX: -6.5, maxX: 6.5, minZ: -6.5, maxZ: 6.5, maxY: 7 },
  });

  // ------------------------------------------------------------------ feel
  const FEEL_KEY = 'cube-squishy-feel';
  const FEEL_KEYS = ['firmness', 'wobble', 'slowRise', 'squeeze', 'grip'];
  function loadFeel() {
    try {
      const saved = JSON.parse(localStorage.getItem(FEEL_KEY) || 'null');
      if (saved && FEEL_KEYS.every((k) => typeof saved[k] === 'number')) return saved;
    } catch (e) { /* storage blocked or corrupt: use the default */ }
    return Object.assign({}, FEEL_PRESETS.jelly);
  }
  const feel = loadFeel();
  let feelParams = sb.applyFeel(feel);

  const feelPanel = $('#feel');
  const feelToggle = $('#feel-toggle');
  const sliders = Array.from(document.querySelectorAll('[data-feel]'));
  const presetButtons = Array.from(document.querySelectorAll('[data-preset]'));

  function renderFeel() {
    for (const input of sliders) input.value = String(feel[input.dataset.feel]);
    for (const b of presetButtons) {
      const p = FEEL_PRESETS[b.dataset.preset];
      const match = FEEL_KEYS.every((k) => Math.abs(p[k] - feel[k]) < 0.005);
      b.setAttribute('aria-pressed', String(match));
    }
  }
  function commitFeel() {
    feelParams = sb.applyFeel(feel);
    renderFeel();
    try { localStorage.setItem(FEEL_KEY, JSON.stringify(feel)); } catch (e) { /* not persisted */ }
  }
  sliders.forEach((input) => input.addEventListener('input', () => {
    feel[input.dataset.feel] = parseFloat(input.value);
    commitFeel();
  }));
  presetButtons.forEach((b) => b.addEventListener('click', () => {
    Object.assign(feel, FEEL_PRESETS[b.dataset.preset]);
    commitFeel();
  }));
  renderFeel();

  // ------------------------------------------------------------------ music
  const music = window.SquishyMusic ? window.SquishyMusic.create() : null;
  const MUSIC_KEY = 'cube-squishy-music';
  let musicPrefs = {};
  try { musicPrefs = JSON.parse(localStorage.getItem(MUSIC_KEY) || 'null') || {}; } catch (e) { /* default */ }
  const musicToggle = $('#music-toggle');
  const playButton = $('#music-play');
  const volumeInput = $('#music-volume');
  if (music) music.setVolume(typeof musicPrefs.volume === 'number' ? musicPrefs.volume : 0.5);
  volumeInput.value = String(music ? music.volume : 0.5);
  // open the music panel and it starts, unless you paused it yourself
  let playOnOpen = musicPrefs.on !== false;
  // music is on by default unless you paused it last visit: start with the
  // first tap or click (browsers won't start audio before one)
  let playOnFirstInput = musicPrefs.on !== false;

  function saveMusic() {
    try { localStorage.setItem(MUSIC_KEY, JSON.stringify({ volume: music.volume, on: music.playing })); } catch (e) { /* not persisted */ }
  }
  function renderMusic() {
    const on = !!(music && music.playing);
    playButton.textContent = on ? 'Pause' : 'Play';
    playButton.setAttribute('aria-pressed', String(on));
    musicToggle.dataset.playing = String(on);
  }
  function setPlaying(on) {
    if (!music || !music.supported) return;
    playOnFirstInput = false;
    if (on) music.start();
    else { music.pause(); playOnOpen = false; }
    renderMusic();
    saveMusic();
  }
  playButton.addEventListener('click', () => setPlaying(!music.playing));
  volumeInput.addEventListener('input', () => {
    if (!music) return;
    music.setVolume(parseFloat(volumeInput.value));
    // turning it up while paused means you want to hear it
    if (!music.playing && music.volume > 0) setPlaying(true);
    else saveMusic();
  });
  if (!music || !music.supported) {
    musicToggle.disabled = true;
    musicToggle.title = 'Music needs the Web Audio API, which this browser does not have';
  }
  // skip the play button itself, or its click would pause what this just started
  document.addEventListener('pointerup', (e) => {
    if (playOnFirstInput && !playButton.contains(e.target)) setPlaying(true);
  }, true);
  let resumeOnShow = false;
  document.addEventListener('visibilitychange', () => {
    if (!music) return;
    if (document.hidden && music.playing) { resumeOnShow = true; music.pause(); renderMusic(); }
    else if (!document.hidden && resumeOnShow) { resumeOnShow = false; music.start(); renderMusic(); }
  });
  renderMusic();

  // ----------------------------------------------------------------- panels
  const panels = {
    feel: { panel: feelPanel, toggle: feelToggle, close: $('#feel-close'), first: () => feelPanel.querySelector('[aria-pressed="true"]') || sliders[0] },
    music: { panel: $('#music'), toggle: musicToggle, close: $('#music-close'), first: () => playButton },
  };
  let openPanel = null;
  function setPanel(name, focusInside) {
    for (const [key, p] of Object.entries(panels)) {
      p.panel.hidden = key !== name;
      p.toggle.setAttribute('aria-expanded', String(key === name));
    }
    openPanel = name;
    if (name === 'music' && playOnOpen && music && !music.playing) {
      playOnOpen = false;
      setPlaying(true);
    }
    if (name && focusInside) panels[name].first().focus({ preventScroll: true });
  }
  for (const [key, p] of Object.entries(panels)) {
    p.toggle.addEventListener('click', () => setPanel(openPanel === key ? null : key, true));
    p.close.addEventListener('click', () => { setPanel(null); p.toggle.focus(); });
  }

  // Rounded box made from a subdivided box: every vertex is clamped to the
  // inner box and pushed out by the corner radius. Duplicate vertices along
  // face seams are kept (for per-face UVs) but mapped to a shared vertex so
  // normals are smooth across the rounded edges.
  function roundedBox(half, corner, seg, displace) {
    const g = new THREE.BoxGeometry(2 * half, 2 * half, 2 * half, seg, seg, seg);
    const P = g.attributes.position.array;
    const n = P.length / 3;
    const inner = half - corner;
    const map = new Uint32Array(n);
    const keys = new Map();
    const uniq = [];
    for (let i = 0; i < n; i++) {
      const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
      const cx = clamp(x, -inner, inner), cy = clamp(y, -inner, inner), cz = clamp(z, -inner, inner);
      const dx = x - cx, dy = y - cy, dz = z - cz;
      const l = Math.hypot(dx, dy, dz) || 1;
      const rx = cx + (dx / l) * corner, ry = cy + (dy / l) * corner, rz = cz + (dz / l) * corner;
      const key = Math.round(rx * 1e4) + ',' + Math.round(ry * 1e4) + ',' + Math.round(rz * 1e4);
      let u = keys.get(key);
      if (u === undefined) {
        u = uniq.length / 3;
        keys.set(key, u);
        let ox = rx, oy = ry, oz = rz;
        if (displace) {
          const d = displace(rx, ry, rz);
          ox += (dx / l) * d; oy += (dy / l) * d; oz += (dz / l) * d;
        }
        uniq.push(ox, oy, oz);
      }
      map[i] = u;
    }
    const idx = g.index.array;
    const tri = new Uint32Array(idx.length);
    for (let i = 0; i < idx.length; i++) tri[i] = map[idx[i]];
    const rest = new Float32Array(uniq);
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    return {
      geometry: g, map, tri, rest,
      emb: sb.embed(rest),
      cur: new Float32Array(rest.length),
      nrm: new Float32Array(rest.length),
    };
  }

  function smoothNormals(pos, tri, out) {
    out.fill(0);
    for (let t = 0; t < tri.length; t += 3) {
      const a = 3 * tri[t], b = 3 * tri[t + 1], c = 3 * tri[t + 2];
      const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
      const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      out[a] += nx; out[a + 1] += ny; out[a + 2] += nz;
      out[b] += nx; out[b + 1] += ny; out[b + 2] += nz;
      out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
    }
    for (let i = 0; i < out.length; i += 3) {
      const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
      out[i] /= l; out[i + 1] /= l; out[i + 2] /= l;
    }
  }

  function syncShape(shape, pushExtra) {
    sb.evaluate(shape.emb, shape.cur);
    pushOutOfFingers(shape.cur, pushExtra);
    smoothNormals(shape.cur, shape.tri, shape.nrm);
    const P = shape.geometry.attributes.position.array;
    const N = shape.geometry.attributes.normal.array;
    const { map, cur, nrm } = shape;
    for (let i = 0; i < map.length; i++) {
      const u = 3 * map[i];
      P[3 * i] = cur[u]; P[3 * i + 1] = cur[u + 1]; P[3 * i + 2] = cur[u + 2];
      N[3 * i] = nrm[u]; N[3 * i + 1] = nrm[u + 1]; N[3 * i + 2] = nrm[u + 2];
    }
    shape.geometry.attributes.position.needsUpdate = true;
    shape.geometry.attributes.normal.needsUpdate = true;
    shape.geometry.computeBoundingSphere();
  }

  // ----------------------------------------------------------- jelly body
  const skin = makeJellySkin();
  const glow = {
    uLampView: { value: new THREE.Vector3() },
    uGlowColor: { value: new THREE.Color(1.0, 0.5, 0.28) },
    uGlowStrength: { value: 0.42 },
  };
  const jellyMat = new THREE.MeshPhysicalMaterial({
    color: 0xfff1e8,
    metalness: 0,
    roughness: 0.55, // scaled down by the roughness map to ~0.16
    roughnessMap: skin.roughnessMap,
    normalMap: skin.normalMap,
    normalScale: new THREE.Vector2(0.18, 0.18),
    transmission: 1,
    thickness: 1.7,
    ior: 1.47,
    attenuationColor: new THREE.Color(1.0, 0.72, 0.56),
    attenuationDistance: 2.6,
    specularIntensity: 1,
    clearcoat: 0.45,
    clearcoatRoughness: 0.14,
    envMapIntensity: 1.15,
  });
  // Cheap subsurface glow: light from the lamp scattering through the jelly
  // towards the viewer, strongest when the lamp is behind the cube and at the
  // thin rounded edges (what makes the real one look lit from inside).
  jellyMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, glow);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform vec3 uLampView;\nuniform vec3 uGlowColor;\nuniform float uGlowStrength;\nvoid main() {')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      {
        vec3 sV = normalize( vViewPosition );
        vec3 sL = normalize( uLampView + vViewPosition );
        vec3 sH = normalize( sL + normal * 0.5 );
        float sBack = pow( clamp( dot( sV, -sH ), 0.0, 1.0 ), 3.0 );
        float sRim = pow( 1.0 - clamp( abs( dot( normal, sV ) ), 0.0, 1.0 ), 2.2 );
        float sWrap = clamp( dot( normal, sL ) * 0.5 + 0.5, 0.0, 1.0 );
        totalEmissiveRadiance += uGlowColor * uGlowStrength * ( sBack * 1.3 + sRim * sWrap * 0.7 + 0.06 );
      }`);
  };
  jellyMat.customProgramCacheKey = () => 'squishy-jelly-glow';

  const jelly = roundedBox(HALF, CORNER, 32);
  const jellyMesh = new THREE.Mesh(jelly.geometry, jellyMat);
  jellyMesh.frustumCulled = false;
  scene.add(jellyMesh);

  // --------------------------------------------------------- glitter core
  // Dense glitter reads as an almost solid magenta cloud, so the core is an
  // opaque lumpy body with a faceted sparkle normal map, wrapped in loose
  // flakes that thin out into the clear jelly.
  const CORE_HALF = 0.6, CORE_CORNER = 0.26;
  const core = roundedBox(CORE_HALF, CORE_CORNER, 16, (x, y, z) => (noise3(x * 3.2 + 7, y * 3.2, z * 3.2, 3) - 0.5) * 0.1);
  const coreMat = new THREE.MeshPhysicalMaterial({
    color: 0xb0136e,
    metalness: 0.55,
    roughness: 0.34,
    normalMap: makeSparkleNormal(),
    normalScale: new THREE.Vector2(1, 1),
    iridescence: 0.35,
    iridescenceIOR: 1.6,
    iridescenceThicknessRange: [180, 520],
    envMapIntensity: 1.5,
  });
  coreMat.normalMap.wrapS = coreMat.normalMap.wrapT = THREE.RepeatWrapping;
  coreMat.normalMap.repeat.set(1.6, 1.6);
  const coreMesh = new THREE.Mesh(core.geometry, coreMat);
  coreMesh.frustumCulled = false;
  scene.add(coreMesh);

  function makeFlakes(count, seed, sizeMin, sizeMax, strayRatio) {
    const rnd = mulberry32(seed);
    const pos = new Float32Array(3 * count);
    const quat = new Float32Array(4 * count);
    const scale = new Float32Array(count);
    let i = 0, guard = 0;
    while (i < count && guard++ < count * 400) {
      const x = (rnd() * 2 - 1) * 0.8, y = (rnd() * 2 - 1) * 0.8, z = (rnd() * 2 - 1) * 0.8;
      const outer = sdRoundBox(x, y, z, HALF, CORNER);
      if (outer > -0.09) continue;
      const stray = rnd() < strayRatio;
      if (!stray) {
        const s = sdRoundBox(x, y, z, CORE_HALF, CORE_CORNER) + (noise3(x * 3 + 2, y * 3, z * 3, 8) - 0.5) * 0.14;
        // a band hugging the core, thinning out into the clear jelly
        if (s < -0.08 || s > 0.17) continue;
        if (rnd() > 1 - smoothstep(0.02, 0.17, s)) continue;
      }
      pos[3 * i] = x; pos[3 * i + 1] = y; pos[3 * i + 2] = z;
      const u1 = rnd(), u2 = rnd() * Math.PI * 2, u3 = rnd() * Math.PI * 2;
      const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
      quat[4 * i] = a * Math.sin(u2); quat[4 * i + 1] = a * Math.cos(u2);
      quat[4 * i + 2] = b * Math.sin(u3); quat[4 * i + 3] = b * Math.cos(u3);
      scale[i] = sizeMin + (sizeMax - sizeMin) * Math.pow(rnd(), 2);
      i++;
    }
    return { count: i, pos, quat, scale, emb: sb.embed(pos.subarray(0, 3 * i)), cur: new Float32Array(3 * i) };
  }

  const hexGeo = new THREE.CircleGeometry(1, 6);
  const pinkFlakes = makeFlakes(4200, 101, 0.016, 0.042, 0.06);
  const holoFlakes = makeFlakes(900, 202, 0.026, 0.055, 0.12);
  const pinkMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0.8, roughness: 0.26, side: THREE.DoubleSide,
    iridescence: 0.4, iridescenceIOR: 1.5, iridescenceThicknessRange: [220, 480], envMapIntensity: 1.6,
  });
  const holoMat = new THREE.MeshPhysicalMaterial({
    color: 0xf3f0ff, metalness: 1, roughness: 0.12, side: THREE.DoubleSide,
    iridescence: 1, iridescenceIOR: 2.0, iridescenceThicknessRange: [120, 900], envMapIntensity: 1.8,
  });
  function flakeMesh(f, mat, palette) {
    const m = new THREE.InstancedMesh(hexGeo, mat, f.count);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    if (palette) {
      const rnd = mulberry32(f.count);
      const col = new THREE.Color();
      for (let i = 0; i < f.count; i++) {
        col.set(palette[(rnd() * palette.length) | 0]);
        m.setColorAt(i, col);
      }
      m.instanceColor.needsUpdate = true;
    }
    scene.add(m);
    return m;
  }
  const pinkMesh = flakeMesh(pinkFlakes, pinkMat, ['#e3177f', '#c4127c', '#ff3d9b', '#a50f6b', '#ff70b8', '#d81e95']);
  const holoMesh = flakeMesh(holoFlakes, holoMat, null);

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _qb = new THREE.Quaternion();
  const _p = new THREE.Vector3(), _s = new THREE.Vector3();
  function syncFlakes(f, mesh) {
    sb.evaluate(f.emb, f.cur);
    pushOutOfFingers(f.cur, 0.12);
    _qb.set(sb.q[0], sb.q[1], sb.q[2], sb.q[3]);
    for (let i = 0; i < mesh.count; i++) {
      _p.set(f.cur[3 * i], f.cur[3 * i + 1], f.cur[3 * i + 2]);
      _q.set(f.quat[4 * i], f.quat[4 * i + 1], f.quat[4 * i + 2], f.quat[4 * i + 3]).premultiply(_qb);
      _s.setScalar(f.scale[i]);
      mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  // --------------------------------------------- contact shadow + caustic
  const softSquare = makeSoftSquare(256, 0.5, 0.45);
  const decalGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  function decal(color, opacity, blending, y) {
    const m = new THREE.Mesh(decalGeo, new THREE.MeshBasicMaterial({
      color, alphaMap: softSquare, transparent: true, opacity, depthWrite: false, blending,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }));
    m.position.y = y;
    m.renderOrder = 1;
    scene.add(m);
    return m;
  }
  const contactAO = decal(0x000000, 0.7, THREE.NormalBlending, 0.003);
  const softShadow = decal(0x0b0604, 0.4, THREE.NormalBlending, 0.004);
  const caustic = decal(new THREE.Color(1.0, 0.42, 0.36), 0.5, THREE.AdditiveBlending, 0.005);

  function updateDecals() {
    const P = sb.pos;
    // pick the body axis that lies flattest on the floor for the footprint yaw
    const R = sb.R;
    const cols = [[R[0], R[3], R[6]], [R[1], R[4], R[7]], [R[2], R[5], R[8]]];
    cols.sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]));
    let ax = cols[0][0], az = cols[0][2];
    const al = Math.hypot(ax, az) || 1;
    ax /= al; az /= al;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity, minY = Infinity, cx = 0, cz = 0;
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], z = P[i + 2];
      const u = x * ax + z * az, v = -x * az + z * ax;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
      if (P[i + 1] < minY) minY = P[i + 1];
      cx += x; cz += z;
    }
    cx /= sb.count; cz /= sb.count;
    const w = maxU - minU, d = maxV - minV;
    const lift = Math.max(0, minY);
    const fade = Math.exp(-lift * 0.8);
    const yaw = Math.atan2(-az, ax);
    let lx = cx - LAMP.x, lz = cz - LAMP.z;
    const ll = Math.hypot(lx, lz) || 1;
    lx /= ll; lz /= ll;

    contactAO.position.set(cx, 0.003, cz);
    contactAO.rotation.y = yaw;
    // texture is opaque out to 1/4 of the plane and fades out by ~1/2
    contactAO.scale.set(w * 1.5 + lift, 1, d * 1.5 + lift);
    contactAO.material.opacity = 0.72 * fade * fade;

    softShadow.position.set(cx + lx * (0.45 + lift * 0.5), 0.004, cz + lz * (0.45 + lift * 0.5));
    softShadow.rotation.y = yaw;
    softShadow.scale.set(w * 2.5 + lift, 1, d * 2.5 + lift);
    softShadow.material.opacity = 0.28 * fade;

    caustic.position.set(cx + lx * (1.6 + lift * 0.6), 0.005, cz + lz * (1.6 + lift * 0.6));
    caustic.rotation.y = Math.atan2(-lz, lx);
    caustic.scale.set(w * 1.2, 1, d * 0.8);
    caustic.material.opacity = 0.4 * fade;
  }

  // -------------------------------------------------------------- fingers
  const fingers = [];
  function makeFinger() {
    const f = { active: false, r: 0.34, len: 4, x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0, ax: 0, ay: 1, az: 0 };
    fingers.push(f);
    sb.fingers.push(f);
    return f;
  }
  const fingerA = makeFinger(), fingerB = makeFinger();

  // Render-side fingertip contact: snap surface points that ended up inside a
  // fingertip onto it with a smooth fillet. The lattice already does the real
  // work; this keeps the dent perfectly round at render resolution.
  function pushOutOfFingers(arr, extra) {
    const k = 0.14;
    for (const f of fingers) {
      if (!f.active) continue;
      const R = f.r + extra, lim = R + k;
      for (let i = 0; i < arr.length; i += 3) {
        const vx = arr[i] - f.x, vy = arr[i + 1] - f.y, vz = arr[i + 2] - f.z;
        let s = vx * f.ax + vy * f.ay + vz * f.az;
        if (s < 0) s = 0; else if (s > f.len) s = f.len;
        const qx = f.x + f.ax * s, qy = f.y + f.ay * s, qz = f.z + f.az * s;
        const dx = arr[i] - qx, dy = arr[i + 1] - qy, dz = arr[i + 2] - qz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= lim * lim || d2 < 1e-12) continue;
        const d = Math.sqrt(d2);
        const h = Math.max(k - Math.abs(d - R), 0) / k;
        const nd = Math.max(d, R) + h * h * k * 0.25;
        const m = nd / d;
        arr[i] = qx + dx * m; arr[i + 1] = qy + dy * m; arr[i + 2] = qz + dz * m;
      }
    }
  }

  // ---------------------------------------------------------------- camera
  const orbit = {
    target: new THREE.Vector3(0, 0.9, 0),
    theta: 0.18, phi: 1.2, radius: 6.6,
    vt: 0, vp: 0,
  };
  function placeCamera() {
    const { theta, phi, radius, target } = orbit;
    camera.position.set(
      target.x + radius * Math.sin(phi) * Math.sin(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * Math.sin(phi) * Math.cos(theta)
    );
    camera.lookAt(target);
  }

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // keep the cube a similar size on tall phone screens
    camera.fov = w / h < 0.8 ? 44 : 32;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // ------------------------------------------------------------ interaction
  const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const MODES = coarse ? {
    press: 'Hold on the cube to push in. Drag while holding to smear it.',
    pinch: 'Hold on the cube to squeeze it front to back.',
    pull: 'Grab the cube and drag to stretch it. Lift it and let go to drop it.',
  } : {
    press: 'Hold on the cube to push in. Keep holding and drag to smear it. Scroll while pressing to push harder.',
    pinch: 'Hold on the cube to squeeze it front to back. Shift-drag does this in any mode.',
    pull: 'Grab the cube and drag to stretch it. Lift it off the floor and let go to drop it.',
  };
  $('#hint .nav').textContent = coarse
    ? 'Pinch two fingers on the cube to squeeze it, or spread them to stretch it. Pinch anywhere else to zoom.'
    : 'Drag the background to look around. Scroll to zoom.';
  let mode = 'press';
  const hintEl = $('#hint .mode');
  const modeButtons = Array.from(document.querySelectorAll('[data-mode]'));
  function setMode(m) {
    mode = m;
    for (const b of modeButtons) b.setAttribute('aria-pressed', String(b.dataset.mode === m));
    hintEl.textContent = MODES[m];
  }
  modeButtons.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  setMode('press');

  function drop() {
    endAction();
    sb.reset(1.1, (Math.random() - 0.5) * 0.5);
  }
  $('#drop').addEventListener('click', drop);

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const tmpNdc = new THREE.Vector2();
  let action = null;
  let last = { x: 0, y: 0 };
  const pointers = new Map(); // pointerId -> { x, y }
  let primary = null; // the pointer driving a one-finger action
  let waitForRelease = false; // after a two-finger gesture, ignore the finger left behind

  function toNdc(x, y, out) {
    const r = canvas.getBoundingClientRect();
    return out.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  }
  function setNdc(e) {
    toNdc(e.clientX, e.clientY, ndc);
  }
  function currentRay() {
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray;
  }
  function rayAt(x, y) {
    raycaster.setFromCamera(toNdc(x, y, tmpNdc), camera);
    return raycaster.ray;
  }
  function restHit(frame) {
    const ray = currentRay();
    const o = ray.origin, d = ray.direction;
    return sb.raycastRest(o.x, o.y, o.z, d.x, d.y, d.z, frame);
  }
  function hitsCubeAt(x, y, frame) {
    const { origin: o, direction: d } = rayAt(x, y);
    return !!sb.raycastRest(o.x, o.y, o.z, d.x, d.y, d.z, frame);
  }

  const brushOpts = { radius: 0.55, stiffness: 0.32, drag: 0.65 };

  function startPress(kind) {
    sb.computeFrame();
    const frame = sb.snapshotFrame();
    const hit = restHit(frame);
    if (!hit) return false;
    const pinch = kind === 'pinch';
    const opts = Object.assign({}, brushOpts, { radius: pinch ? 0.5 : 0.55 });
    const brushes = [sb.createBrush(frame, opts)];
    if (pinch) brushes.push(sb.createBrush(frame, opts));
    action = {
      kind, frame, brushes, held: true, depth: 0,
      maxDepth: feelParams.pressDepth * (pinch ? 0.88 : 1),
      tIn: hit.tIn, tOut: hit.tOut, n: [hit.nx, hit.ny, hit.nz],
    };
    updatePress(0, true);
    return true;
  }

  function updatePress(dt, first) {
    const a = action;
    const hit = restHit(a.frame);
    if (hit) { a.tIn = hit.tIn; a.tOut = hit.tOut; a.n = [hit.nx, hit.ny, hit.nz]; }
    const ray = raycaster.ray;
    const o = ray.origin, d = ray.direction;
    a.depth += (a.maxDepth - a.depth) * (1 - Math.exp(-3.4 * dt));
    const depth = a.depth;

    // front contact; a single press leans into the surface normal so pokes on
    // a side face push into the cube rather than skating along it
    const pIn = [o.x + d.x * a.tIn, o.y + d.y * a.tIn, o.z + d.z * a.tIn];
    let dir;
    if (a.kind === 'pinch') {
      dir = [d.x, d.y, d.z];
    } else {
      dir = [d.x * 0.55 - a.n[0] * 0.45, d.y * 0.55 - a.n[1] * 0.45, d.z * 0.55 - a.n[2] * 0.45];
      const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      dir = dir.map((v) => v / l);
    }
    setBrush(a.brushes[0], fingerA, pIn, dir, depth, dt, first);
    if (a.kind === 'pinch') {
      const pOut = [o.x + d.x * a.tOut, o.y + d.y * a.tOut, o.z + d.z * a.tOut];
      setBrush(a.brushes[1], fingerB, pOut, [-d.x, -d.y, -d.z], depth, dt, first);
    }
  }

  function setBrush(b, f, p, dir, depth, dt, first) {
    b.p = p.slice();
    b.dir = dir;
    b.depth = depth;
    if (first) {
      b.pp = p.slice(); b.l = p.slice(); b.pl = p.slice(); b.pdepth = depth;
    } else {
      const k = 1 - Math.exp(-dt / 0.12);
      for (let i = 0; i < 3; i++) b.l[i] += (p[i] - b.l[i]) * k;
    }
    // fingertip sphere sits just behind the dent, the finger trails back out
    f.x = p[0] + dir[0] * (depth - f.r);
    f.y = p[1] + dir[1] * (depth - f.r);
    f.z = p[2] + dir[2] * (depth - f.r);
    f.ax = -dir[0]; f.ay = -dir[1]; f.az = -dir[2];
    if (first || !f.active) { f.px = f.x; f.py = f.y; f.pz = f.z; }
    f.active = true;
  }

  const grabPlane = new THREE.Plane();
  const grabPoint = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  function startPull() {
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObject(jellyMesh, false);
    let p;
    if (hits.length) p = hits[0].point.clone();
    else {
      const h = restHit();
      if (!h) return false;
      const o = raycaster.ray.origin, d = raycaster.ray.direction;
      p = o.clone().addScaledVector(d, h.tIn);
    }
    if (!sb.startGrab(p.x, p.y, p.z, 0.62)) return false;
    camera.getWorldDirection(camDir);
    grabPlane.setFromNormalAndCoplanarPoint(camDir, p);
    action = { kind: 'pull' };
    canvas.style.cursor = 'grabbing';
    return true;
  }
  function updatePull() {
    raycaster.setFromCamera(ndc, camera);
    if (raycaster.ray.intersectPlane(grabPlane, grabPoint)) {
      sb.grab.target = [clamp(grabPoint.x, -6, 6), clamp(grabPoint.y, 0, 6), clamp(grabPoint.z, -6, 6)];
    }
  }

  // ---- two fingers: squeeze or stretch the cube, or zoom the camera
  // Your two fingers are projected onto a plane through the cube facing the
  // camera. The cube is pressed from both ends of the line through them, so
  // pinching squeezes it along whatever direction your fingers line up, and
  // spreading them pulls the two sides out.
  const squeezePlane = new THREE.Plane();
  const fingerPosA = new THREE.Vector3(), fingerPosB = new THREE.Vector3(), squeezeCentre = new THREE.Vector3();
  function twoFingers() {
    const [a, b] = Array.from(pointers.values());
    return { a, b, d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }
  function startTwoFinger() {
    endAction();
    primary = null;
    sb.computeFrame();
    const frame = sb.snapshotFrame();
    const t = twoFingers();
    const onCube = hitsCubeAt(t.a.x, t.a.y, frame) || hitsCubeAt(t.b.x, t.b.y, frame) || hitsCubeAt(t.mx, t.my, frame);
    if (!onCube) {
      action = { kind: 'zoom', d0: Math.max(t.d, 1), r0: orbit.radius };
      return;
    }
    camera.getWorldDirection(camDir);
    squeezeCentre.set(frame.c[0], frame.c[1], frame.c[2]);
    squeezePlane.setFromNormalAndCoplanarPoint(camDir, squeezeCentre);
    action = {
      kind: 'squeeze', frame,
      brushes: [sb.createBrush(frame, brushOpts), sb.createBrush(frame, brushOpts)],
      w0: null, depth: 0, axis: [1, 0, 0],
    };
    updateSqueeze(0, true);
  }
  function updateSqueeze(dt, first) {
    const a = action;
    const t = twoFingers();
    if (!rayAt(t.a.x, t.a.y).intersectPlane(squeezePlane, fingerPosA)) return;
    if (!rayAt(t.b.x, t.b.y).intersectPlane(squeezePlane, fingerPosB)) return;
    const w = fingerPosA.distanceTo(fingerPosB);
    if (a.w0 === null) a.w0 = w;
    if (w > 1e-3) {
      a.axis = [(fingerPosB.x - fingerPosA.x) / w, (fingerPosB.y - fingerPosA.y) / w, (fingerPosB.z - fingerPosA.z) / w];
    }
    const ax = a.axis, c = squeezeCentre;
    // squeeze line passes through the fingers' midpoint, kept inside the cube
    let qx = (fingerPosA.x + fingerPosB.x) / 2 - c.x;
    let qy = (fingerPosA.y + fingerPosB.y) / 2 - c.y;
    let qz = (fingerPosA.z + fingerPosB.z) / 2 - c.z;
    const along = qx * ax[0] + qy * ax[1] + qz * ax[2];
    qx -= ax[0] * along; qy -= ax[1] * along; qz -= ax[2] * along;
    const off = Math.hypot(qx, qy, qz);
    if (off > 0.75) { qx *= 0.75 / off; qy *= 0.75 / off; qz *= 0.75 / off; }
    qx += c.x; qy += c.y; qz += c.z;
    const far = 4;
    const ha = sb.raycastRest(qx - ax[0] * far, qy - ax[1] * far, qz - ax[2] * far, ax[0], ax[1], ax[2], a.frame);
    const hb = sb.raycastRest(qx + ax[0] * far, qy + ax[1] * far, qz + ax[2] * far, -ax[0], -ax[1], -ax[2], a.frame);
    if (!ha || !hb) return;
    const ca = [qx + ax[0] * (ha.tIn - far), qy + ax[1] * (ha.tIn - far), qz + ax[2] * (ha.tIn - far)];
    const cb = [qx - ax[0] * (hb.tIn - far), qy - ax[1] * (hb.tIn - far), qz - ax[2] * (hb.tIn - far)];
    // fingers moving together squeezes (positive), apart stretches (negative)
    const target = clamp((a.w0 - w) / 2 + 0.04, -0.38, feelParams.pressDepth * 1.25);
    a.depth = first ? target : a.depth + (target - a.depth) * (1 - Math.exp(-12 * dt));
    setBrush(a.brushes[0], fingerA, ca, ax, a.depth, dt, first);
    setBrush(a.brushes[1], fingerB, cb, [-ax[0], -ax[1], -ax[2]], a.depth, dt, first);
  }

  function endAction() {
    if (!action) return;
    if (action.kind === 'pull') sb.endGrab();
    if (action.brushes) action.brushes.forEach((b) => sb.removeBrush(b));
    fingerA.active = fingerB.active = false;
    action = null;
  }

  function overCube() {
    return !!restHit();
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
    if (pointers.size === 2) { startTwoFinger(); return; }
    if (pointers.size > 2 || waitForRelease) return;
    primary = e.pointerId;
    setNdc(e);
    last = { x: e.clientX, y: e.clientY };
    let kind = mode;
    if (e.shiftKey) kind = 'pinch';
    if (e.button === 2 || e.altKey) kind = 'pull';
    const started = kind === 'pull' ? startPull() : startPress(kind);
    if (!started) {
      action = { kind: 'orbit' };
      orbit.vt = orbit.vp = 0;
      canvas.style.cursor = 'grabbing';
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (p) { p.x = e.clientX; p.y = e.clientY; }
    if (action && action.kind === 'zoom') {
      orbit.radius = clamp(action.r0 * action.d0 / Math.max(twoFingers().d, 1), 3.6, 10);
      return;
    }
    if (action && action.kind === 'squeeze') return; // follows the fingers every frame
    if (pointers.size > 1 || waitForRelease) return;
    if (primary !== null && e.pointerId !== primary) return;
    setNdc(e);
    if (action && action.kind === 'orbit') {
      const dx = e.clientX - last.x, dy = e.clientY - last.y;
      orbit.vt = -dx * 0.0055;
      orbit.vp = -dy * 0.0055;
      orbit.theta += orbit.vt;
      orbit.phi += orbit.vp;
    } else if (!action && e.pointerType === 'mouse') {
      canvas.style.cursor = overCube() ? (mode === 'pull' ? 'grab' : 'pointer') : 'default';
    }
    last = { x: e.clientX, y: e.clientY };
  });

  function release(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (action && (action.kind === 'squeeze' || action.kind === 'zoom')) {
      endAction();
      waitForRelease = pointers.size > 0;
    } else if (e.pointerId === primary) {
      primary = null;
      if (action && action.kind === 'orbit') action = null;
      else endAction();
    }
    if (pointers.size === 0) waitForRelease = false;
    canvas.style.cursor = 'default';
  }
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (action && (action.kind === 'press' || action.kind === 'pinch')) {
      action.maxDepth = clamp(action.maxDepth - e.deltaY * 0.0012, 0.12, 0.85);
    } else {
      orbit.radius = clamp(orbit.radius * Math.exp(e.deltaY * 0.0012), 3.6, 10);
    }
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    const tag = e.target && e.target.tagName;
    if ((tag === 'INPUT' || tag === 'TEXTAREA') && e.key !== 'Escape') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === '1') setMode('press');
    else if (k === '2') setMode('pinch');
    else if (k === '3') setMode('pull');
    else if (k === 'r') drop();
    else if (k === 'f') setPanel(openPanel === 'feel' ? null : 'feel', false);
    else if (k === 'm' && music && music.supported) setPlaying(!music.playing);
    else if (e.key === 'Escape' && openPanel) {
      const toggle = panels[openPanel].toggle;
      setPanel(null);
      toggle.focus();
    }
  });

  // ---------------------------------------------------------------- quality
  // Drop resolution, glitter count and solver rate in steps if the frame rate
  // stays low. Phones start one step down.
  const QUALITY = [
    { pixelRatio: 2, flakes: 1, rate: 720, maxSub: 24 },
    { pixelRatio: 1.5, flakes: 0.7, rate: 720, maxSub: 24 },
    { pixelRatio: 1.15, flakes: 0.45, rate: 600, maxSub: 18 },
    { pixelRatio: 0.9, flakes: 0.3, rate: 480, maxSub: 16 },
  ];
  const deviceRatio = window.devicePixelRatio || 1;
  let qualityLevel = coarse ? 1 : 0;
  let qTime = 0, qFrames = 0, qWait = 3;
  function applyQuality() {
    const q = QUALITY[qualityLevel];
    renderer.setPixelRatio(Math.min(deviceRatio, q.pixelRatio));
    resize();
    pinkMesh.count = Math.round(pinkFlakes.count * q.flakes);
    holoMesh.count = Math.round(holoFlakes.count * q.flakes);
  }
  function watchQuality(rawDt) {
    if (qualityLevel >= QUALITY.length - 1 || document.hidden || rawDt > 0.25) return;
    if ((qWait -= rawDt) > 0) return;
    qTime += rawDt;
    qFrames++;
    if (qTime < 2) return;
    const avg = qTime / qFrames;
    qTime = 0; qFrames = 0;
    if (avg > 1 / 40) {
      qualityLevel++;
      applyQuality();
      qWait = 2;
    }
  }
  applyQuality();

  // ------------------------------------------------------------------ loop
  if (!reduceMotion) sb.reset(1.2, 0.22); // land on an edge for a first wobble
  sb.computeFrame();

  const lampView = new THREE.Vector3();
  let prevT = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const raw = (now - prevT) / 1000;
    const dt = Math.min(Math.max(raw, 1 / 240), 1 / 30);
    prevT = now;
    watchQuality(raw);

    if (!action || action.kind !== 'orbit') {
      orbit.theta += orbit.vt;
      orbit.phi += orbit.vp;
      orbit.vt *= Math.exp(-dt * 6);
      orbit.vp *= Math.exp(-dt * 6);
    }
    orbit.phi = clamp(orbit.phi, 0.32, 1.45);
    placeCamera();
    camera.updateMatrixWorld();

    if (action) {
      if (action.kind === 'press' || action.kind === 'pinch') updatePress(dt, false);
      else if (action.kind === 'squeeze') updateSqueeze(dt, false);
      else if (action.kind === 'pull') updatePull();
    }

    // keep the solver's substep near 1/720 s (1/480 s on slow devices)
    const q = QUALITY[qualityLevel];
    sb.substeps = clamp(Math.round(dt * q.rate), 6, q.maxSub);
    sb.step(dt);
    if (!sb.isHealthy()) {
      endAction();
      sb.reset(1.0, 0.2);
    }
    sb.computeFrame();

    syncShape(jelly, 0);
    syncShape(core, 0.16);
    syncFlakes(pinkFlakes, pinkMesh);
    syncFlakes(holoFlakes, holoMesh);
    updateDecals();

    lampView.copy(LAMP_POS).applyMatrix4(camera.matrixWorldInverse);
    glow.uLampView.value.copy(lampView);

    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
})();

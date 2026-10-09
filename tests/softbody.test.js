// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { SoftBody } = require('../src/softbody.js');

const DT = 1 / 60;
const run = (sb, frames, each) => {
  for (let i = 0; i < frames; i++) {
    if (each) each(i);
    sb.step(DT);
  }
};
const pressAt = (sb, p, dir) => {
  const b = sb.createBrush(sb.computeFrame().snapshotFrame());
  Object.assign(b, { p: p.slice(), pp: p.slice(), l: p.slice(), pl: p.slice(), dir });
  return b;
};

test('settles on the floor without drifting or blowing up', () => {
  const sb = new SoftBody();
  sb.reset(0.8, 0.3);
  run(sb, 240);
  assert.ok(sb.isHealthy());
  const b = sb.bounds();
  assert.ok(Math.abs(b.min[1]) < 1e-6, 'rests on the ground');
  assert.ok(b.max[1] > 1.95 && b.max[1] < 2.02, `height ${b.max[1]}`);
  assert.ok(Math.abs(sb.volumeRatio() - 1) < 0.01);
});

test('pressing the top dents it, bulges the sides, then springs back', () => {
  const sb = new SoftBody();
  run(sb, 60);
  const brush = pressAt(sb, [0, 2, 0], [0, -1, 0]);
  run(sb, 90, (i) => { brush.depth = 0.55 * Math.min(1, i / 30); });
  const pressed = sb.bounds();
  assert.ok(pressed.max[0] - pressed.min[0] > 2.05, 'sides bulge');
  assert.ok(sb.volumeRatio() > 0.97, `volume ${sb.volumeRatio()}`);
  sb.removeBrush(brush);
  run(sb, 180);
  const after = sb.bounds();
  assert.ok(Math.abs(after.max[1] - 1.985) < 0.03, `top ${after.max[1]}`);
  assert.ok(sb.isHealthy());
});

test('pinch from both sides keeps the volume', () => {
  const sb = new SoftBody();
  run(sb, 60);
  const a = pressAt(sb, [0, 1, 1], [0, 0, -1]);
  const b = pressAt(sb, [0, 1, -1], [0, 0, 1]);
  run(sb, 120, (i) => { a.depth = b.depth = 0.5 * Math.min(1, i / 30); });
  assert.ok(sb.volumeRatio() > 0.96);
  assert.ok(sb.bounds().max[1] > 2.03, 'squeezed jelly rises');
});

test('grab lifts the whole cube and it drops back intact', () => {
  const sb = new SoftBody();
  run(sb, 60);
  sb.computeFrame();
  assert.ok(sb.startGrab(0, 2, 0, 0.6));
  run(sb, 120, (i) => { sb.grab.target = [0, 2 + 2.5 * Math.min(1, i / 40), 0]; });
  assert.ok(sb.bounds().min[1] > 1, 'lifted off the floor');
  sb.endGrab();
  run(sb, 240);
  const b = sb.bounds();
  assert.ok(sb.isHealthy());
  assert.ok(b.min[1] < 1e-6 && b.max[1] < 2.05);
});

test('raycast against the rest shape finds both faces', () => {
  const sb = new SoftBody();
  sb.computeFrame();
  const hit = sb.raycastRest(0, 1, 6, 0, 0, -1);
  assert.ok(hit);
  assert.ok(Math.abs(hit.tIn - 5) < 1e-3, `tIn ${hit.tIn}`);
  assert.ok(Math.abs(hit.tOut - 7) < 1e-3, `tOut ${hit.tOut}`);
  assert.ok(Math.abs(hit.nz - 1) < 1e-3);
  assert.equal(sb.raycastRest(5, 5, 6, 0, 0, -1), null);
});

test('embedding reproduces rest positions exactly', () => {
  const sb = new SoftBody();
  const pts = new Float32Array([0, 0, 0, 0.93, -0.41, 0.2, -1, 1, -1, 0.5, 0.5, 0.999]);
  const emb = sb.embed(pts);
  const out = sb.evaluate(emb, new Float32Array(pts.length));
  for (let i = 0; i < pts.length; i++) {
    const expected = pts[i] + (i % 3 === 1 ? 1 : 0); // body sits at y = 1
    assert.ok(Math.abs(out[i] - expected) < 1e-5);
  }
});

// ------------------------------------------------------------------- feel
const { FEEL_PRESETS } = require('../src/softbody.js');

const pressTopAndRelease = (feel) => {
  const sb = new SoftBody();
  const p = sb.applyFeel(feel);
  run(sb, 120);
  const top = sb.bounds().max[1];
  // particle at the top centre-ish
  let id = 0, best = Infinity;
  for (let i = 0; i < sb.count; i++) {
    const d = sb.pos[3 * i] ** 2 + (sb.pos[3 * i + 1] - top) ** 2 + sb.pos[3 * i + 2] ** 2;
    if (d < best) { best = d; id = i; }
  }
  const y0 = sb.pos[3 * id + 1];
  const brush = pressAt(sb, [0, top, 0], [0, -1, 0]);
  run(sb, 90, (i) => { brush.depth = p.pressDepth * Math.min(1, i / 20); });
  const dent = y0 - sb.pos[3 * id + 1];
  sb.removeBrush(brush);
  const after = (seconds) => { run(sb, Math.round(seconds * 60)); return y0 - sb.pos[3 * id + 1]; };
  return { sb, dent, after };
};

test('every preset stays stable through a press', () => {
  for (const [name, feel] of Object.entries(FEEL_PRESETS)) {
    const { sb, after } = pressTopAndRelease(feel);
    after(3);
    assert.ok(sb.isHealthy(), name);
  }
});

test('firm dents less than jelly', () => {
  assert.ok(pressTopAndRelease(FEEL_PRESETS.firm).dent < pressTopAndRelease(FEEL_PRESETS.jelly).dent * 0.7);
});

test('slow rise keeps the dent for a while, then recovers', () => {
  const { after } = pressTopAndRelease(FEEL_PRESETS.foam);
  assert.ok(after(1) > 0.15, 'still dented after 1 s');
  assert.ok(after(9) < 0.05, 'risen after 10 s');
});

test('slow rise does not slump under its own weight', () => {
  const sb = new SoftBody();
  sb.applyFeel({ firmness: 0, squeeze: 1, wobble: 0, slowRise: 1, grip: 0.5 });
  run(sb, 600);
  assert.ok(sb.bounds().max[1] > 1.85, `height ${sb.bounds().max[1]}`);
});

/*
 * softbody.js
 *
 * Volumetric soft body for the cube squishy. No dependencies, runs in the
 * browser (window.SquishyPhysics) and in Node (module.exports) for tests.
 *
 * Model
 *   - A regular lattice of particles fills the cube's bounding box.
 *   - Every lattice cell is split into 5 tetrahedra (parity alternates per
 *     cell so neighbouring cells share face diagonals).
 *   - XPBD with many small substeps solves tet edge lengths (shear/stretch
 *     stiffness) and tet volumes (near incompressible, so pressing one side
 *     makes the other sides bulge like real TPR jelly).
 *   - Anything that should deform with the jelly (render mesh, glitter) is
 *     embedded with trilinear weights in the rest lattice.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SquishyPhysics = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Corner l of a cell is (l & 1, (l >> 1) & 1, (l >> 2) & 1).
  const TETS_EVEN = [[0, 3, 5, 6], [1, 0, 3, 5], [2, 0, 3, 6], [4, 0, 5, 6], [7, 3, 5, 6]];
  const TETS_ODD = [[1, 2, 4, 7], [0, 1, 2, 4], [3, 1, 2, 7], [5, 1, 4, 7], [6, 2, 4, 7]];

  function sdRoundBox(x, y, z, b, r) {
    const qx = Math.abs(x) - b + r;
    const qy = Math.abs(y) - b + r;
    const qz = Math.abs(z) - b + r;
    const mx = qx > 0 ? qx : 0;
    const my = qy > 0 ? qy : 0;
    const mz = qz > 0 ? qz : 0;
    return Math.sqrt(mx * mx + my * my + mz * mz) + Math.min(Math.max(qx, qy, qz), 0) - r;
  }

  function tetVolume(p, a, b, c, d) {
    const ax = p[3 * a], ay = p[3 * a + 1], az = p[3 * a + 2];
    const e1x = p[3 * b] - ax, e1y = p[3 * b + 1] - ay, e1z = p[3 * b + 2] - az;
    const e2x = p[3 * c] - ax, e2y = p[3 * c + 1] - ay, e2z = p[3 * c + 2] - az;
    const e3x = p[3 * d] - ax, e3y = p[3 * d + 1] - ay, e3z = p[3 * d + 2] - az;
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    return (cx * e3x + cy * e3y + cz * e3z) / 6;
  }

  class SoftBody {
    constructor(o = {}) {
      this.res = o.resolution ?? 10; // particles per axis
      this.half = o.halfSize ?? 1;
      this.cornerRadius = o.cornerRadius ?? 0.28;
      this.home = o.home ?? [0, this.half, 0];
      this.gravity = o.gravity ?? -30;
      this.substeps = o.substeps ?? 12;
      this.edgeCompliance = o.edgeCompliance ?? 2.5e-5;
      this.volumeCompliance = o.volumeCompliance ?? 1.5e-9;
      this.damping = o.damping ?? 0.15; // air drag on all motion, 1/s
      // Damping of deformation only (velocity relative to the centre of mass),
      // 1/s. Low = jiggly jelly, high = dead and doughy. Falling isn't slowed.
      this.internalDamping = o.internalDamping ?? 1.6;
      // Slow rise (memory foam). Strain past yieldStrain creeps into the rest
      // shape at creepRate, and the rest shape recovers at recoveryRate (1/s).
      // recoveryRate 0 turns it off, which is a plain elastic jelly.
      this.recoveryRate = o.recoveryRate ?? 0;
      this.creepRate = o.creepRate ?? 7;
      this.yieldStrain = o.yieldStrain ?? 0.03;
      this.groundY = o.groundY ?? 0;
      this.groundFriction = o.groundFriction ?? 0.97;
      this.box = o.box ?? { minX: -8, maxX: 8, minZ: -4.9, maxZ: 8, maxY: 8 };
      this.obstacles = o.obstacles ?? []; // vertical cylinders { x, z, r }
      this.maxSpeed = o.maxSpeed ?? 60;

      this.fingers = []; // capsule colliders: { active, x,y,z, px,py,pz, ax,ay,az (axis toward the hand), r }
      this.brushes = []; // press fields, see setBrush()
      this.grab = {
        active: false, ids: null, weights: null, offsets: null,
        target: [0, 0, 0], stiffness: o.grabStiffness ?? 0.3,
      };

      this.c = [0, 0, 0];
      this.q = [0, 0, 0, 1];
      this.R = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]); // row major

      this._build();
      this.reset(0);
    }

    _build() {
      const n = this.res;
      const half = this.half;
      const h = (2 * half) / (n - 1);
      const N = n * n * n;
      this.spacing = h;
      this.count = N;
      this.rest = new Float64Array(3 * N);
      this.pos = new Float64Array(3 * N);
      this.prev = new Float64Array(3 * N);
      this.vel = new Float64Array(3 * N);
      this.invMass = new Float64Array(N).fill(1);

      const idx = (i, j, k) => i + n * (j + n * k);
      for (let k = 0; k < n; k++) {
        for (let j = 0; j < n; j++) {
          for (let i = 0; i < n; i++) {
            const p = idx(i, j, k);
            this.rest[3 * p] = -half + i * h;
            this.rest[3 * p + 1] = -half + j * h;
            this.rest[3 * p + 2] = -half + k * h;
          }
        }
      }

      const tets = [];
      const restVol = [];
      const edgeKeys = new Map();
      const edges = [];
      const addEdge = (a, b) => {
        const lo = Math.min(a, b), hi = Math.max(a, b);
        const key = lo * N + hi;
        if (edgeKeys.has(key)) return;
        edgeKeys.set(key, edges.length / 2);
        edges.push(lo, hi);
      };
      const corner = new Array(8);
      for (let k = 0; k < n - 1; k++) {
        for (let j = 0; j < n - 1; j++) {
          for (let i = 0; i < n - 1; i++) {
            for (let l = 0; l < 8; l++) {
              corner[l] = idx(i + (l & 1), j + ((l >> 1) & 1), k + ((l >> 2) & 1));
            }
            const table = (i + j + k) & 1 ? TETS_ODD : TETS_EVEN;
            for (const t of table) {
              const a = corner[t[0]], b = corner[t[1]];
              let c = corner[t[2]], d = corner[t[3]];
              let v = tetVolume(this.rest, a, b, c, d);
              if (v < 0) { const s = c; c = d; d = s; v = -v; }
              tets.push(a, b, c, d);
              restVol.push(v);
              addEdge(a, b); addEdge(a, c); addEdge(a, d);
              addEdge(b, c); addEdge(b, d); addEdge(c, d);
            }
          }
        }
      }
      this.tets = new Int32Array(tets);
      this.restVol = new Float64Array(restVol);
      this.edges = new Int32Array(edges);
      this.restLen = new Float64Array(edges.length / 2);
      this.edgePlastic = new Float64Array(edges.length / 2);
      this.volPlastic = new Float64Array(restVol.length);
      for (let e = 0; e < this.restLen.length; e++) {
        const a = 3 * this.edges[2 * e], b = 3 * this.edges[2 * e + 1];
        const dx = this.rest[b] - this.rest[a];
        const dy = this.rest[b + 1] - this.rest[a + 1];
        const dz = this.rest[b + 2] - this.rest[a + 2];
        this.restLen[e] = Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
    }

    reset(dropHeight = 0, tilt = 0) {
      const [hx, hy, hz] = this.home;
      const ct = Math.cos(tilt), st = Math.sin(tilt);
      for (let p = 0; p < this.count; p++) {
        const x = this.rest[3 * p], y = this.rest[3 * p + 1], z = this.rest[3 * p + 2];
        // optional tilt about the z axis so a drop lands on an edge and wobbles
        const rx = ct * x - st * y;
        const ry = st * x + ct * y;
        this.pos[3 * p] = hx + rx;
        this.pos[3 * p + 1] = hy + ry + dropHeight;
        this.pos[3 * p + 2] = hz + z;
      }
      this.prev.set(this.pos);
      this.vel.fill(0);
      this.edgePlastic.fill(0);
      this.volPlastic.fill(0);
      this.grab.active = false;
      for (const f of this.fingers) f.active = false;
      this.brushes.length = 0;
      this.q = [0, 0, 0, 1];
      this.computeFrame();
    }

    // ---------------------------------------------------------------- step

    step(dt) {
      if (!(dt > 0)) return;
      const sub = this.substeps;
      const sdt = dt / sub;
      for (let s = 0; s < sub; s++) {
        this._integrate(sdt);
        const reverse = (s & 1) === 1;
        this._solveEdges(sdt, reverse);
        this._solveVolumes(sdt, reverse);
        this._solveGrab();
        this._solveBrushes((s + 1) / sub);
        this._solveFingers((s + 1) / sub);
        this._solveBounds();
        this._updateVelocities(sdt);
      }
      this._updatePlasticity(dt);
      for (const f of this.fingers) {
        f.px = f.x; f.py = f.y; f.pz = f.z;
      }
      for (const b of this.brushes) {
        b.pp[0] = b.p[0]; b.pp[1] = b.p[1]; b.pp[2] = b.p[2];
        b.pl[0] = b.l[0]; b.pl[1] = b.l[1]; b.pl[2] = b.l[2];
        b.pdepth = b.depth;
      }
    }

    _integrate(sdt) {
      const { pos, prev, vel, count } = this;
      const g = this.gravity * sdt;
      const air = Math.max(0, 1 - this.damping * sdt);
      const inner = Math.max(0, 1 - this.internalDamping * sdt);
      const vmax = this.maxSpeed, vmax2 = vmax * vmax;
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < vel.length; i += 3) { cx += vel[i]; cy += vel[i + 1]; cz += vel[i + 2]; }
      cx /= count; cy /= count; cz /= count;
      for (let i = 0; i < pos.length; i += 3) {
        let vx = (cx + (vel[i] - cx) * inner) * air;
        let vy = (cy + (vel[i + 1] - cy) * inner) * air + g;
        let vz = (cz + (vel[i + 2] - cz) * inner) * air;
        const s2 = vx * vx + vy * vy + vz * vz;
        if (s2 > vmax2) {
          const k = vmax / Math.sqrt(s2);
          vx *= k; vy *= k; vz *= k;
        }
        vel[i] = vx; vel[i + 1] = vy; vel[i + 2] = vz;
        prev[i] = pos[i]; prev[i + 1] = pos[i + 1]; prev[i + 2] = pos[i + 2];
        pos[i] += vx * sdt; pos[i + 1] += vy * sdt; pos[i + 2] += vz * sdt;
      }
    }

    _updatePlasticity(dt) {
      const ep = this.edgePlastic, vp = this.volPlastic;
      if (!(this.recoveryRate > 0)) {
        if (this._plasticDirty) { ep.fill(0); vp.fill(0); this._plasticDirty = false; }
        return;
      }
      this._plasticDirty = true;
      const { pos, edges, restLen, tets, restVol } = this;
      const y = this.yieldStrain;
      // Only hands leave dents. Gravity and landing from a drop don't creep,
      // otherwise a very soft foam would slowly slump under its own weight.
      const touched = this.brushes.length > 0 || this.grab.active;
      const creep = touched ? Math.min(1, this.creepRate * dt) : 0;
      const recover = Math.exp(-this.recoveryRate * dt);
      const flow = (p, strain) => {
        const d = strain - p;
        if (d > y) p += (d - y) * creep;
        else if (d < -y) p += (d + y) * creep;
        p *= recover;
        return p < -0.6 ? -0.6 : p > 0.6 ? 0.6 : p;
      };
      for (let e = 0; e < ep.length; e++) {
        const a = 3 * edges[2 * e], b = 3 * edges[2 * e + 1];
        const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
        ep[e] = flow(ep[e], Math.sqrt(dx * dx + dy * dy + dz * dz) / restLen[e] - 1);
      }
      for (let t = 0; t < vp.length; t++) {
        const v = tetVolume(pos, tets[4 * t], tets[4 * t + 1], tets[4 * t + 2], tets[4 * t + 3]);
        vp[t] = flow(vp[t], v / restVol[t] - 1);
      }
    }

    _solveEdges(sdt, reverse) {
      const { pos, edges, restLen, invMass } = this;
      const plastic = this.recoveryRate > 0 ? this.edgePlastic : null;
      const alpha = this.edgeCompliance / (sdt * sdt);
      const m = restLen.length;
      // alternate sweep direction so Gauss-Seidel ordering doesn't bias the shape
      for (let q = 0; q < m; q++) {
        const e = reverse ? m - 1 - q : q;
        const i0 = edges[2 * e], i1 = edges[2 * e + 1];
        const w0 = invMass[i0], w1 = invMass[i1];
        const w = w0 + w1;
        if (w === 0) continue;
        const a = 3 * i0, b = 3 * i1;
        const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-12) continue;
        const C = len - (plastic ? restLen[e] * (1 + plastic[e]) : restLen[e]);
        const s = -C / (w + alpha) / len;
        pos[a] -= dx * s * w0; pos[a + 1] -= dy * s * w0; pos[a + 2] -= dz * s * w0;
        pos[b] += dx * s * w1; pos[b + 1] += dy * s * w1; pos[b + 2] += dz * s * w1;
      }
    }

    _solveVolumes(sdt, reverse) {
      const { pos, tets, restVol, invMass } = this;
      const plastic = this.recoveryRate > 0 ? this.volPlastic : null;
      const alpha = this.volumeCompliance / (sdt * sdt);
      const m = restVol.length;
      for (let q = 0; q < m; q++) {
        const t = reverse ? m - 1 - q : q;
        const i0 = tets[4 * t], i1 = tets[4 * t + 1], i2 = tets[4 * t + 2], i3 = tets[4 * t + 3];
        const a = 3 * i0, b = 3 * i1, c = 3 * i2, d = 3 * i3;
        const x0 = pos[a], y0 = pos[a + 1], z0 = pos[a + 2];
        const x1 = pos[b], y1 = pos[b + 1], z1 = pos[b + 2];
        const x2 = pos[c], y2 = pos[c + 1], z2 = pos[c + 2];
        const x3 = pos[d], y3 = pos[d + 1], z3 = pos[d + 2];
        // gradient of V = ((x1-x0) x (x2-x0)) . (x3-x0) / 6 for each vertex
        // g1 = (x2-x0) x (x3-x0) / 6, g2 = (x3-x0) x (x1-x0) / 6, g3 = (x1-x0) x (x2-x0) / 6
        const e1x = x1 - x0, e1y = y1 - y0, e1z = z1 - z0;
        const e2x = x2 - x0, e2y = y2 - y0, e2z = z2 - z0;
        const e3x = x3 - x0, e3y = y3 - y0, e3z = z3 - z0;
        const g1x = (e2y * e3z - e2z * e3y) / 6, g1y = (e2z * e3x - e2x * e3z) / 6, g1z = (e2x * e3y - e2y * e3x) / 6;
        const g2x = (e3y * e1z - e3z * e1y) / 6, g2y = (e3z * e1x - e3x * e1z) / 6, g2z = (e3x * e1y - e3y * e1x) / 6;
        const g3x = (e1y * e2z - e1z * e2y) / 6, g3y = (e1z * e2x - e1x * e2z) / 6, g3z = (e1x * e2y - e1y * e2x) / 6;
        const g0x = -g1x - g2x - g3x, g0y = -g1y - g2y - g3y, g0z = -g1z - g2z - g3z;
        const w0 = invMass[i0], w1 = invMass[i1], w2 = invMass[i2], w3 = invMass[i3];
        const w = w0 * (g0x * g0x + g0y * g0y + g0z * g0z) + w1 * (g1x * g1x + g1y * g1y + g1z * g1z) +
          w2 * (g2x * g2x + g2y * g2y + g2z * g2z) + w3 * (g3x * g3x + g3y * g3y + g3z * g3z);
        if (w < 1e-20) continue;
        const vol = g3x * e3x + g3y * e3y + g3z * e3z;
        const s = -(vol - (plastic ? restVol[t] * (1 + plastic[t]) : restVol[t])) / (w + alpha);
        let k = s * w0; pos[a] += g0x * k; pos[a + 1] += g0y * k; pos[a + 2] += g0z * k;
        k = s * w1; pos[b] += g1x * k; pos[b + 1] += g1y * k; pos[b + 2] += g1z * k;
        k = s * w2; pos[c] += g2x * k; pos[c + 1] += g2y * k; pos[c + 2] += g2z * k;
        k = s * w3; pos[d] += g3x * k; pos[d + 1] += g3y * k; pos[d + 2] += g3z * k;
      }
    }

    _solveGrab() {
      const gr = this.grab;
      if (!gr.active || !gr.ids) return;
      const { pos } = this;
      const T = gr.target, s = gr.stiffness;
      for (let k = 0; k < gr.ids.length; k++) {
        const i = 3 * gr.ids[k];
        const w = gr.weights[k] * s;
        pos[i] += (T[0] + gr.offsets[3 * k] - pos[i]) * w;
        pos[i + 1] += (T[1] + gr.offsets[3 * k + 1] - pos[i + 1]) * w;
        pos[i + 2] += (T[2] + gr.offsets[3 * k + 2] - pos[i + 2]) * w;
      }
    }

    /**
     * Press field. Nodes near the contact point P (measured on the undeformed
     * cube in the frame captured when the press started) are softly pulled
     * toward their rest position pushed in along the press direction. The
     * profile is smooth, so the dent is smooth even though the lattice is
     * coarse, and the volume constraints make the rest of the cube bulge.
     */
    _solveBrushes(t) {
      const { pos } = this;
      for (const b of this.brushes) {
        if (!b.active) continue;
        const X = b.restWorld, mask = b.mask;
        const px = b.pp[0] + (b.p[0] - b.pp[0]) * t;
        const py = b.pp[1] + (b.p[1] - b.pp[1]) * t;
        const pz = b.pp[2] + (b.p[2] - b.pp[2]) * t;
        const lx = b.pl[0] + (b.l[0] - b.pl[0]) * t;
        const ly = b.pl[1] + (b.l[1] - b.pl[1]) * t;
        const lz = b.pl[2] + (b.l[2] - b.pl[2]) * t;
        const depth = b.pdepth + (b.depth - b.pdepth) * t;
        // tangential drag: material under the finger lags behind when you slide
        const sx = (px - lx) * b.drag, sy = (py - ly) * b.drag, sz = (pz - lz) * b.drag;
        const dx = b.dir[0] * depth, dy = b.dir[1] * depth, dz = b.dir[2] * depth;
        const rad = b.radius, rad2 = rad * rad, k = b.stiffness;
        for (let i = 0; i < pos.length; i += 3) {
          const ex = X[i] - px, ey = X[i + 1] - py, ez = X[i + 2] - pz;
          const d2 = ex * ex + ey * ey + ez * ez;
          if (d2 >= rad2) continue;
          const m = mask[i / 3];
          if (m === 0) continue;
          const u = 1 - d2 / rad2;
          const phi = u * u * (3 - 2 * u); // smooth, flat top, zero slope at the rim
          const w = k * phi * m;
          pos[i] += (X[i] + sx * phi + dx * phi - pos[i]) * w;
          pos[i + 1] += (X[i + 1] + sy * phi + dy * phi - pos[i + 1]) * w;
          pos[i + 2] += (X[i + 2] + sz * phi + dz * phi - pos[i + 2]) * w;
        }
      }
    }

    /** Fingertips as capsules: a sphere at the tip plus the finger behind it. */
    _solveFingers(t) {
      const { pos } = this;
      for (const f of this.fingers) {
        if (!f.active) continue;
        const cx = f.px + (f.x - f.px) * t;
        const cy = f.py + (f.y - f.py) * t;
        const cz = f.pz + (f.z - f.pz) * t;
        const ax = f.ax, ay = f.ay, az = f.az, len = f.len;
        const r = f.r, r2 = r * r;
        for (let i = 0; i < pos.length; i += 3) {
          let vx = pos[i] - cx, vy = pos[i + 1] - cy, vz = pos[i + 2] - cz;
          let s = vx * ax + vy * ay + vz * az;
          if (s < 0) s = 0; else if (s > len) s = len;
          const qx = cx + ax * s, qy = cy + ay * s, qz = cz + az * s;
          vx = pos[i] - qx; vy = pos[i + 1] - qy; vz = pos[i + 2] - qz;
          const d2 = vx * vx + vy * vy + vz * vz;
          if (d2 >= r2) continue;
          if (d2 < 1e-18) { pos[i] = qx - ax * r; pos[i + 1] = qy - ay * r; pos[i + 2] = qz - az * r; continue; }
          const k = r / Math.sqrt(d2);
          pos[i] = qx + vx * k; pos[i + 1] = qy + vy * k; pos[i + 2] = qz + vz * k;
        }
      }
    }

    /**
     * Create a press field. p: contact point on the undeformed surface,
     * dir: unit press direction (into the cube), frame: body frame snapshot.
     */
    createBrush(frame, opts = {}) {
      const X = new Float64Array(3 * this.count);
      const R = frame.R, c = frame.c, rest = this.rest;
      for (let i = 0; i < X.length; i += 3) {
        const x = rest[i], y = rest[i + 1], z = rest[i + 2];
        X[i] = c[0] + R[0] * x + R[1] * y + R[2] * z;
        X[i + 1] = c[1] + R[3] * x + R[4] * y + R[5] * z;
        X[i + 2] = c[2] + R[6] * x + R[7] * y + R[8] * z;
      }
      // Only the skin is driven; the interior is left to the volume
      // constraints so the jelly flows out to the sides instead of compacting.
      const mask = new Float64Array(this.count);
      const shell = (opts.shell ?? 1.5) * this.spacing;
      for (let i = 0; i < this.count; i++) {
        const d = this.sdfLocal(rest[3 * i], rest[3 * i + 1], rest[3 * i + 2]);
        mask[i] = Math.min(1, Math.max(0, 1 + d / shell));
      }
      const b = {
        active: true,
        restWorld: X,
        mask,
        p: [0, 0, 0], pp: [0, 0, 0], // contact point now / last step
        l: [0, 0, 0], pl: [0, 0, 0], // lagging contact point (for drag)
        dir: [0, -1, 0],
        depth: 0, pdepth: 0,
        radius: opts.radius ?? 0.55,
        stiffness: opts.stiffness ?? 0.35,
        drag: opts.drag ?? 0.7,
      };
      this.brushes.push(b);
      return b;
    }

    removeBrush(b) {
      const i = this.brushes.indexOf(b);
      if (i >= 0) this.brushes.splice(i, 1);
    }

    _solveBounds() {
      const { pos, prev } = this;
      const gy = this.groundY, mu = this.groundFriction;
      const b = this.box;
      const obs = this.obstacles;
      for (let i = 0; i < pos.length; i += 3) {
        if (pos[i + 1] < gy) {
          pos[i + 1] = gy;
          // TPR is tacky: strong static-ish friction against the floor
          pos[i] = prev[i] + (pos[i] - prev[i]) * (1 - mu);
          pos[i + 2] = prev[i + 2] + (pos[i + 2] - prev[i + 2]) * (1 - mu);
        }
        if (pos[i + 1] > b.maxY) pos[i + 1] = b.maxY;
        if (pos[i] < b.minX) pos[i] = b.minX; else if (pos[i] > b.maxX) pos[i] = b.maxX;
        if (pos[i + 2] < b.minZ) pos[i + 2] = b.minZ; else if (pos[i + 2] > b.maxZ) pos[i + 2] = b.maxZ;
        for (let o = 0; o < obs.length; o++) {
          const c = obs[o];
          const dx = pos[i] - c.x, dz = pos[i + 2] - c.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < c.r * c.r && pos[i + 1] < c.h) {
            const d = Math.sqrt(d2) || 1e-6;
            pos[i] = c.x + (dx / d) * c.r;
            pos[i + 2] = c.z + (dz / d) * c.r;
          }
        }
      }
    }

    _updateVelocities(sdt) {
      const { pos, prev, vel } = this;
      const inv = 1 / sdt;
      for (let i = 0; i < pos.length; i++) vel[i] = (pos[i] - prev[i]) * inv;
    }

    // ---------------------------------------------------------- body frame

    /** Centre of mass and best-fit rotation (Müller et al. 2016, iterative). */
    computeFrame(iterations = 12) {
      const { pos, rest, count } = this;
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < pos.length; i += 3) { cx += pos[i]; cy += pos[i + 1]; cz += pos[i + 2]; }
      cx /= count; cy /= count; cz /= count;
      // A = sum (x - c) X^T, stored row major
      const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i] - cx, y = pos[i + 1] - cy, z = pos[i + 2] - cz;
        const X = rest[i], Y = rest[i + 1], Z = rest[i + 2];
        A[0] += x * X; A[1] += x * Y; A[2] += x * Z;
        A[3] += y * X; A[4] += y * Y; A[5] += y * Z;
        A[6] += z * X; A[7] += z * Y; A[8] += z * Z;
      }
      let [qx, qy, qz, qw] = this.q;
      const R = this.R;
      for (let it = 0; it < iterations; it++) {
        quatToMat(qx, qy, qz, qw, R);
        let ox = 0, oy = 0, oz = 0, dot = 0;
        for (let j = 0; j < 3; j++) {
          const rx = R[j], ry = R[3 + j], rz = R[6 + j];
          const ax = A[j], ay = A[3 + j], az = A[6 + j];
          ox += ry * az - rz * ay;
          oy += rz * ax - rx * az;
          oz += rx * ay - ry * ax;
          dot += rx * ax + ry * ay + rz * az;
        }
        const inv = 1 / (Math.abs(dot) + 1e-9);
        ox *= inv; oy *= inv; oz *= inv;
        const w = Math.sqrt(ox * ox + oy * oy + oz * oz);
        if (w < 1e-9) break;
        const s = Math.sin(w / 2) / w, c = Math.cos(w / 2);
        const ax = ox * s, ay = oy * s, az = oz * s, aw = c;
        // q = dq * q
        const nx = aw * qx + ax * qw + ay * qz - az * qy;
        const ny = aw * qy - ax * qz + ay * qw + az * qx;
        const nz = aw * qz + ax * qy - ay * qx + az * qw;
        const nw = aw * qw - ax * qx - ay * qy - az * qz;
        const nl = Math.hypot(nx, ny, nz, nw) || 1;
        qx = nx / nl; qy = ny / nl; qz = nz / nl; qw = nw / nl;
      }
      quatToMat(qx, qy, qz, qw, R);
      this.q = [qx, qy, qz, qw];
      this.c = [cx, cy, cz];
      return this;
    }

    snapshotFrame() {
      return { c: this.c.slice(), R: Float64Array.from(this.R), q: this.q.slice() };
    }

    // ----------------------------------------------------------- embedding

    /** Trilinear weights of rest-space points (relative to the cube centre). */
    embed(points) {
      const n = this.res, h = this.spacing, half = this.half;
      const count = points.length / 3;
      const ids = new Int32Array(8 * count);
      const ws = new Float32Array(8 * count);
      const cell = (v) => {
        const f = (v + half) / h;
        const i = Math.min(n - 2, Math.max(0, Math.floor(f)));
        return [i, f - i];
      };
      for (let p = 0; p < count; p++) {
        const [i, tx] = cell(points[3 * p]);
        const [j, ty] = cell(points[3 * p + 1]);
        const [k, tz] = cell(points[3 * p + 2]);
        for (let l = 0; l < 8; l++) {
          const dx = l & 1, dy = (l >> 1) & 1, dz = (l >> 2) & 1;
          ids[8 * p + l] = (i + dx) + n * ((j + dy) + n * (k + dz));
          ws[8 * p + l] = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz);
        }
      }
      return { ids, ws, count };
    }

    evaluate(emb, out) {
      const { pos } = this;
      const { ids, ws, count } = emb;
      for (let p = 0; p < count; p++) {
        let x = 0, y = 0, z = 0;
        const o = 8 * p;
        for (let l = 0; l < 8; l++) {
          const i = 3 * ids[o + l], w = ws[o + l];
          x += pos[i] * w; y += pos[i + 1] * w; z += pos[i + 2] * w;
        }
        out[3 * p] = x; out[3 * p + 1] = y; out[3 * p + 2] = z;
      }
      return out;
    }

    // ------------------------------------------------------------ queries

    sdfLocal(x, y, z) {
      return sdRoundBox(x, y, z, this.half, this.cornerRadius);
    }

    /**
     * Ray against the undeformed cube placed at a body frame (defaults to the
     * current one). Returns entry/exit distances and the world entry normal.
     */
    raycastRest(ox, oy, oz, dx, dy, dz, frame) {
      const f = frame || this;
      const R = f.R, c = f.c;
      const px = ox - c[0], py = oy - c[1], pz = oz - c[2];
      // local = R^T * world
      const lx = R[0] * px + R[3] * py + R[6] * pz;
      const ly = R[1] * px + R[4] * py + R[7] * pz;
      const lz = R[2] * px + R[5] * py + R[8] * pz;
      const ux = R[0] * dx + R[3] * dy + R[6] * dz;
      const uy = R[1] * dx + R[4] * dy + R[7] * dz;
      const uz = R[2] * dx + R[5] * dy + R[8] * dz;
      const rb = this.half * Math.sqrt(3) + 0.01;
      const b = lx * ux + ly * uy + lz * uz;
      const cc = lx * lx + ly * ly + lz * lz - rb * rb;
      const disc = b * b - cc;
      if (disc < 0) return null;
      const sq = Math.sqrt(disc);
      const t0 = Math.max(0, -b - sq), t1 = -b + sq;
      if (t1 <= 0) return null;
      const eps = 1e-4;
      let t = t0, tIn = -1;
      for (let it = 0; it < 96 && t <= t1; it++) {
        const d = this.sdfLocal(lx + ux * t, ly + uy * t, lz + uz * t);
        if (d < eps) { tIn = t; break; }
        t += d;
      }
      if (tIn < 0) return null;
      let tOut = t1;
      t = t1;
      for (let it = 0; it < 96 && t >= tIn; it++) {
        const d = this.sdfLocal(lx + ux * t, ly + uy * t, lz + uz * t);
        if (d < eps) { tOut = t; break; }
        t -= d;
      }
      // normal at entry (local gradient, then rotate to world)
      const hx = lx + ux * tIn, hy = ly + uy * tIn, hz = lz + uz * tIn, e = 1e-3;
      let nx = this.sdfLocal(hx + e, hy, hz) - this.sdfLocal(hx - e, hy, hz);
      let ny = this.sdfLocal(hx, hy + e, hz) - this.sdfLocal(hx, hy - e, hz);
      let nz = this.sdfLocal(hx, hy, hz + e) - this.sdfLocal(hx, hy, hz - e);
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      return {
        tIn, tOut,
        nx: R[0] * nx + R[1] * ny + R[2] * nz,
        ny: R[3] * nx + R[4] * ny + R[5] * nz,
        nz: R[6] * nx + R[7] * ny + R[8] * nz,
      };
    }

    // --------------------------------------------------------------- grab

    startGrab(px, py, pz, radius) {
      const { pos } = this;
      const ids = [], ws = [], offs = [];
      const r2 = radius * radius;
      for (let i = 0; i < this.count; i++) {
        const dx = pos[3 * i] - px, dy = pos[3 * i + 1] - py, dz = pos[3 * i + 2] - pz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= r2) continue;
        const f = 1 - d2 / r2;
        ids.push(i); ws.push(f * f); offs.push(dx, dy, dz);
      }
      if (!ids.length) return false;
      const g = this.grab;
      g.ids = Int32Array.from(ids);
      g.weights = Float64Array.from(ws);
      g.offsets = Float64Array.from(offs);
      g.target = [px, py, pz];
      g.active = true;
      return true;
    }

    endGrab() {
      this.grab.active = false;
    }

    // ------------------------------------------------------------ metrics

    volumeRatio() {
      let v = 0, v0 = 0;
      const { tets, restVol, pos } = this;
      for (let t = 0; t < restVol.length; t++) {
        v += tetVolume(pos, tets[4 * t], tets[4 * t + 1], tets[4 * t + 2], tets[4 * t + 3]);
        v0 += restVol[t];
      }
      return v / v0;
    }

    /** False if the simulation produced NaNs or flew apart. */
    isHealthy() {
      const { pos } = this;
      for (let i = 0; i < pos.length; i++) {
        const v = pos[i];
        if (v !== v || v > 50 || v < -50) return false;
      }
      return true;
    }

    bounds() {
      const { pos } = this;
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < pos.length; i += 3) {
        for (let a = 0; a < 3; a++) {
          const v = pos[i + a];
          if (v < mn[a]) mn[a] = v;
          if (v > mx[a]) mx[a] = v;
        }
      }
      return { min: mn, max: mx };
    }
  }

  // ------------------------------------------------------------------ feel
  // Slider values (0..1) to solver parameters. Kept here so the mapping is
  // tested together with the solver's stability limits.
  const lerpLog = (a, b, t) => a * Math.pow(b / a, t);
  const FEEL_PRESETS = {
    jelly: { firmness: 0.38, wobble: 0.59, slowRise: 0, squeeze: 0, grip: 0.96 },
    firm: { firmness: 0.86, wobble: 0.48, slowRise: 0, squeeze: 0.1, grip: 0.9 },
    mochi: { firmness: 0.12, wobble: 0.22, slowRise: 0.3, squeeze: 0.12, grip: 1 },
    foam: { firmness: 0.3, wobble: 0, slowRise: 0.85, squeeze: 0.8, grip: 0.95 },
  };
  function feelToParams(f) {
    const edgeCompliance = lerpLog(1.2e-4, 2e-6, f.firmness);
    // volume must stay softer than about edgeCompliance * 3e-5 or the
    // Gauss-Seidel sweep goes unstable; 6e-5 is the stiffest we allow. Past
    // ~1e-3 a soft cube can collapse into a squashed state it can't leave.
    const volumeCompliance = edgeCompliance * lerpLog(6e-5, 1e-3, f.squeeze);
    return {
      edgeCompliance,
      volumeCompliance,
      internalDamping: lerpLog(14, 0.35, f.wobble),
      // 0 = elastic; otherwise the dent takes roughly 1 / rate seconds to rise
      recoveryRate: f.slowRise > 0.01 ? lerpLog(6, 0.3, f.slowRise) : 0,
      groundFriction: 0.5 + 0.49 * f.grip,
      // how far a fingertip sinks in at full press, firmer = shallower
      pressDepth: 0.27 + 0.45 * (1 - f.firmness),
    };
  }

  function quatToMat(x, y, z, w, out) {
    const xx = x * x, yy = y * y, zz = z * z;
    const xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
    out[0] = 1 - 2 * (yy + zz); out[1] = 2 * (xy - wz); out[2] = 2 * (xz + wy);
    out[3] = 2 * (xy + wz); out[4] = 1 - 2 * (xx + zz); out[5] = 2 * (yz - wx);
    out[6] = 2 * (xz - wy); out[7] = 2 * (yz + wx); out[8] = 1 - 2 * (xx + yy);
    return out;
  }

  SoftBody.prototype.applyFeel = function (feel) {
    const p = feelToParams(feel);
    this.edgeCompliance = p.edgeCompliance;
    this.volumeCompliance = p.volumeCompliance;
    this.internalDamping = p.internalDamping;
    this.recoveryRate = p.recoveryRate;
    this.groundFriction = p.groundFriction;
    return p;
  };

  return { SoftBody, sdRoundBox, tetVolume, feelToParams, FEEL_PRESETS };
});

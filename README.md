# squishy

A clear jelly cube squishy with a magenta glitter core, built in three.js. It sits on a dark floor against a black background, and you can press, pinch and pull it with the pointer. The cube is a volumetric soft body, so pressing one side makes the other sides bulge and it wobbles when you let go.

No build step and no npm dependencies. three.js r149 loads from jsDelivr.

## Run it

Open `index.html` in a browser, or serve the folder:

```sh
npm start            # python3 -m http.server 5173, then open http://localhost:5173
```

## Controls

| Input | What it does |
| --- | --- |
| Drag on the cube (Press) | A fingertip pushes in. Hold longer to push deeper, drag while holding to smear the dent |
| Shift + drag, or Pinch mode | Two fingers squeeze the cube front to back along your view |
| Right-drag, Alt + drag, or Pull mode | Grab a chunk and stretch it. Lift it off the floor and let go to drop it |
| Scroll while pressing | Press harder or softer |
| Drag the background | Orbit the camera |
| Scroll | Zoom |
| `1` `2` `3` | Press, Pinch, Pull |
| `R` | Drop the cube again |
| `F` | Open or close the feel settings |

## Squishy feel

The **Feel** button opens a panel with four presets and five sliders. Changes apply live and are saved in the browser.

| Preset | What it's like |
| --- | --- |
| Jelly | The default. Soft, keeps its volume, jiggles when you let go |
| Firm | Solid rubbery squishy. Shallow dents, a short quick wobble |
| Mochi | Very soft and doughy. No jiggle, settles back over about a second |
| Slow rise | Memory foam. Dents stay put and rise back over about 4 seconds |

| Slider | Low end | High end |
| --- | --- | --- |
| Firmness | Soft | Solid (also makes your finger sink in less) |
| Wobble | Settles at once | Jiggly |
| Slow rise | Springs back | Rises slowly |
| When squeezed | Bulges out (keeps volume, like jelly) | Compresses (like foam) |
| Grip on the floor | Slippery | Tacky |

## How it works

### Physics (`src/softbody.js`)

- A 10 x 10 x 10 particle lattice fills the cube. Each cell is split into 5 tetrahedra, alternating parity per cell so neighbouring cells share face diagonals.
- XPBD with small substeps (about 1/720 s, so 12 per frame at 60 Hz) solves two constraint types per tetrahedron: edge lengths (shear and stretch stiffness) and signed volume (near incompressible). Sweep direction alternates every substep to avoid Gauss-Seidel bias.
- Damping is split in two: a little air drag on everything, and internal damping that only acts on motion relative to the centre of mass, so a dead, doughy squishy still falls at normal speed.
- Slow rise is plasticity, not extra damping. While a hand is touching the cube, strain past 3% creeps into each edge's and tet's rest length and volume, and those rest values relax back to the original at a set rate. Damping-based approaches also make the cube too weak to hold its own weight, so they were rejected. Creep is ignored for gravity and landings, so a soft foam never slumps.
- The floor is a ground plane with high friction because TPR jelly is tacky. Invisible walls keep the cube inside the lit area.
- **Press** is a smooth displacement field, not a hard sphere: skin particles near the contact point are pulled toward their rest position pushed in along the press direction. Only the skin is driven, the interior is left to the volume constraints, so material flows out to the sides. The contact point is measured on the undeformed cube in the pose captured when you started pressing, which keeps the finger from chasing its own dent.
- **Fingers** are capsules (tip sphere plus the finger behind it) so particles can't slip over the top of a fingertip.
- **Pull** pins a weighted patch of particles to a target on a camera-facing plane.
- `computeFrame()` gives the centre of mass and best-fit rotation (iterative polar decomposition, Müller et al. 2016). It's used for the glitter orientation, raycasting and the shadow footprint.

The solver has no three.js dependency and runs in Node for tests.

### Rendering (`src/main.js`)

- The jelly is a rounded box (32 segments per face) embedded in the lattice with trilinear weights. Normals are recomputed every frame on a seam-merged topology so the rounded edges stay smooth while each face keeps its own UVs.
- On top of the lattice result, render vertices that end up inside a fingertip are pushed onto it with a smooth fillet, so the dent is round at render resolution.
- `MeshPhysicalMaterial` with transmission, thickness, IOR 1.47, a peach attenuation tint, clearcoat and a procedural skin (dust specks and hairline scratches in the normal and roughness maps). A small `onBeforeCompile` hook adds a cheap subsurface glow when the lamp is behind the cube and along thin edges.
- The glitter core is an opaque, slightly lumpy rounded box with a faceted sparkle normal map, wrapped in about 5,000 instanced hex flakes (magenta plus iridescent holographic ones). Everything is embedded in the same lattice, so the glitter squishes with the jelly.
- The background is pure black. A warm point light off to the right and behind the cube gives the backlit glow, a soft spotlight from above makes a pool of light on the floor, and reflections come from a PMREM environment of a black studio with a few emissive panels.
- The floor is dark and slightly satin with a faint mottled roughness, lit only near the cube. A radial falloff and black fog fade it into the background, so it grounds the cube without reading as a specific surface.
- Contact shadow, soft shadow and the pink caustic on the floor are decals sized from the current footprint. The jelly does not cast a shadow map, since a solid black shadow looks wrong for a clear object.
- The jelly skin, floor roughness and sparkle map are generated on a canvas at startup. No image assets.

## Tuning

The sliders map to solver options in `feelToParams()` in `src/softbody.js`, and the presets are `FEEL_PRESETS` in the same file. The underlying constructor options:

| Option | Jelly value | Effect |
| --- | --- | --- |
| `edgeCompliance` | `2.5e-5` | Higher is softer. The slider covers `1.2e-4` to `2e-6` |
| `volumeCompliance` | `1.5e-9` | Lower is more incompressible. It is set as a multiple of `edgeCompliance` between `6e-5` and `1e-3`. Below about `3e-5` the solver goes unstable; above `1e-3` a soft cube can collapse into a squashed state it can't leave |
| `internalDamping` | `1.6` | Wobble decay per second, deformation only |
| `damping` | `0.15` | Air drag per second |
| `recoveryRate` | `0` | Slow-rise recovery per second. `0` turns plasticity off |
| `groundFriction` | `0.97` | How tacky the floor contact is |
| `resolution` | `10` | Particles per axis. Cost grows with the cube of this |

Press feel lives in `startPress()` in `src/main.js` (`radius`, `stiffness`, `drag`). Press depth comes from firmness.

## Tests

```sh
npm test
```

Covers settling, press and recovery, pinch volume, lift and drop, the rest-shape raycast, the embedding, and the feel settings (every preset stable, firm dents less than jelly, slow rise holds a dent and recovers, soft foam doesn't slump).

## Single-file build

```sh
npm run build        # writes dist/index.html with the local scripts inlined
```

## Layout

```
index.html            page, styles, UI
src/softbody.js       soft body solver (no dependencies)
src/main.js           scene, materials, interaction
scripts/build.mjs     single-file build
tests/                node:test suite for the solver
```

## Notes

- three.js is pinned to r149, the last release whose classic UMD build (`build/three.min.js`) is not deprecated, and it already has the material features used here (transmission with attenuation, iridescence). Moving to a newer version means switching to ES modules and replacing `outputEncoding` / `physicallyCorrectLights` with their renamed equivalents.
- Transmission in three.js only sees opaque objects, which is why the glitter is opaque and the decals are not visible through the jelly.

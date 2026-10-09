# squishy

**[Try it live → chrispope.github.io/squishy](https://chrispope.github.io/squishy/)**

A clear jelly cube squishy with a magenta glitter core, built in three.js. Press, pinch and pull it: it's a volumetric soft body, so squeezing one side bulges the others and it wobbles when you let go.

No build step and no npm dependencies. three.js r149 loads from jsDelivr.

## Run it

Open `index.html` in a browser, or serve the folder with `npm start` and open http://localhost:5173.

## Controls

| Input | What it does |
| --- | --- |
| Drag on the cube | Press. Hold to push deeper, drag to smear the dent |
| Shift + drag | Pinch front to back |
| Right-drag or Alt + drag | Pull. Lift it and let go to drop it |
| Scroll while pressing | Press harder or softer |
| Drag background / scroll | Orbit / zoom |
| `1` `2` `3` | Press, Pinch, Pull mode |
| `R` / `F` / `M` | Reset cube / feel settings / music |

On touch devices, one finger uses the mode selected in the bottom bar, two fingers on the cube squeeze or stretch it, and gestures on the background orbit and zoom.

## Feel and music

The **Feel** panel has four presets (Jelly, Firm, Mochi, Slow rise) and sliders for firmness, wobble, slow rise, squeeze behaviour and floor grip. Changes apply live and are saved in the browser. Presets and slider mappings live in `FEEL_PRESETS` and `feelToParams()` in `src/softbody.js`.

Music is on by default and starts with your first tap or click (browsers block audio before one); the note button pauses it or changes the volume. It's a generative ambient soundtrack (pads, chimes, air) synthesized live with the Web Audio API in `src/music.js`. No audio files.

## How it works

- **Physics** (`src/softbody.js`): a 10×10×10 particle lattice split into tetrahedra, solved with XPBD (edge-length and volume constraints, ~12 substeps per frame). Slow rise is modelled as plasticity, and presses are a smooth displacement field on the skin. The solver has no three.js dependency and runs in Node for tests.
- **Rendering** (`src/main.js`): a rounded-box mesh and ~5,000 glitter flakes are embedded in the lattice so they deform with it. The jelly uses `MeshPhysicalMaterial` transmission with procedural textures generated at startup, so there are no image assets. Quality steps down automatically if the frame rate drops.

## Development

```sh
npm test             # node:test suite for the solver
npm run build        # writes dist/index.html with local scripts inlined
```

```
index.html            page, styles, UI
src/softbody.js       soft body solver
src/main.js           scene, materials, interaction
src/music.js          generative ambient music
scripts/build.mjs     single-file build
tests/                solver tests
```

three.js is pinned to r149, the last release with a non-deprecated UMD build. Upgrading means moving to ES modules and renaming `outputEncoding` / `physicallyCorrectLights`.

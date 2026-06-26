# Mesh Ritual

Upload a **`.glb`** model, break it apart, and make each piece **audio-reactive**.
Built on the same audio + element-allocation backbone as FrameRitual / ShaderRitual.

Two engine modes:

### 1. Split by Parts
Decomposes the model by its authored meshes/nodes. Each part becomes an element
you can independently:
- **assign to a band** — Low / Mid / High (or None)
- **choose what the band drives** — Scale, Glow (emissive), Explode (push outward), or Rotate
- **set a reactive amount**
- **hide** with a SHOWN/HIDDEN toggle

"Auto-distribute bands" instantly spreads the parts across Low/Mid/High with varied targets.

### 2. Fracture
Procedurally shatters the model into N fragments (k-means triangle clustering —
works even on a single fused mesh). Each fragment keeps the **original
materials** (colour *and* texture) of the triangles it was built from, via
geometry groups indexing the shared cloned-material array. Fragments react as a group:
- **Explode / Scale / Spin**, each wired to a band with its own amount
- **Distribute across bands** — split the fragments into thirds driven by Low/Mid/High
- **Fragment count** (4–200) and visibility

### Screen Capture
Share a window/screen (`getDisplayMedia`) and project it into the scene as a
**Rear Wall** backdrop or a camera-facing **Floating Plane**, with opacity,
scale, and optional audio-reactive pulsing wired to a band.

Plus global **Scene** (auto-rotate, speed, bloom), **Response Profile**
(smoothing + per-band gain), **Noise Gates**, and **MIDI-learn** on every amount slider.
Drag to orbit, scroll to zoom (OrbitControls).

## Architecture

| File | Responsibility |
| --- | --- |
| `analyser.ts` | Web Audio `AnalyserNode` FFT wrapper |
| `audio-bands.ts` | Splits FFT into Low/Mid/High, sensitivity + noise gate |
| `decompose.ts` | Walks the glTF scene graph into addressable `Part`s (clones materials) |
| `fracture.ts` | k-means triangle clustering → fragment meshes |
| `mesh-view.ts` | Three.js scene: GLTF load, fit, env/bloom, per-frame reactivity |
| `main.ts` | Lit UI: upload, mode toggle, per-part & fracture menus, MIDI, metering |
| `types.ts` | Shared config + part/fragment types |

## How a band reaches a part

Each frame `mesh-view.ts` computes gated Low/Mid/High, then per part:
`value = band === 'none' ? 0 : bands[band] * amount`, applied to the chosen
target (scale / emissive intensity / outward offset / spin). Fracture mode does
the same per fragment (optionally split across bands).

## Run locally

```bash
npm install
npm run dev
```

Open the gear → upload a `.glb` → **Ignite Audio** → play sound near the mic.
Try a multi-part model (e.g. a robot/character) for Parts mode, or any model for Fracture.

## Notes / extending

- Compressed (DRACO) `.glb` files are supported via the gstatic decoder CDN.
- Add new reactive targets by extending `ReactTarget` in `types.ts` and the
  `switch` in `mesh-view.ts#animateParts`.
- Fracture is a spatial triangle-cluster shatter, not a convex Voronoi
  decomposition — a true CSG fracture could be added as a separate builder.

# Shader Ritual

An audio-reactive **shader manipulation** playground, built in the spirit of
FrameRitual but focused on Shadertoy-style fragment shaders instead of 3D
geometry.

Every shader is broken into named **elements**. For each element you can:

- **Assign an audio band** — split the signal into **Low / Mid / High** and wire
  any element to any band (or `None`).
- **Set a reactive amount** — how strongly that band drives the element.
- **Hide it** — toggle each element on/off independently.

Each shader has its own menu generated from its element list, so the element →
audio mapping is per-shader. MIDI-learn is available on every amount slider.

## Architecture

| File | Responsibility |
| --- | --- |
| `analyser.ts` | Web Audio `AnalyserNode` FFT wrapper |
| `audio-bands.ts` | Splits FFT into Low/Mid/High, applies sensitivity + noise gate |
| `shaders/common.ts` | Shared full-screen-quad vertex shader |
| `shaders/sanctum.ts` | The first shader (Buffer A + Image bloom pass) with element metadata |
| `shader-registry.ts` | Shader list + default/sanitized config |
| `shader-view.ts` | Three.js two-pass renderer; auto-creates per-element uniforms |
| `main.ts` | Lit UI: shader selector, per-element menus, MIDI, audio, metering |
| `types.ts` | Shared config + shader-definition types |

### How an element maps to the shader

For each element `<id>` the renderer auto-creates two uniforms:

- `<id>_react` = `bandValue * amount` (the live reactive value)
- `<id>_visible` = `1.0` / `0.0` (the hide toggle)

The shader reads these to modulate or remove that part of the image. For the
`sanctum` shader:

| Element | `_react` drives | `_visible` hides |
| --- | --- | --- |
| `core` | morph + spin of the central fractal | the central object |
| `beams` | emission + glow of the moving light bars | the bars |
| `walls` | surface brightness of the chamber | the architecture |
| `bloom` | post-process bloom spread | the bloom (passes through) |

## Add a new shader

1. Create `shaders/<name>.ts` exporting a `ShaderDef` (buffer + image GLSL and
   an `elements` array). Reference `<id>_react` / `<id>_visible` uniforms in the
   GLSL for each element.
2. Register it in `shader-registry.ts` (`SHADERS` array).

The UI and uniform wiring are generated automatically from the element list.

## Run locally

```bash
npm install
npm run dev
```

Then click the gear icon → **Ignite Audio** and play sound near your mic.

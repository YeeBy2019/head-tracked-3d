# Sources and notices

Everything this repository did not write itself, and the terms it comes under.

## The scene

`public/splats/playroom.spz` — 1,916,379 gaussians, 30.1 MB (SPZ v2).

| Stage | What it is | Terms |
| --- | --- | --- |
| Capture | **Deep Blending** dataset, scene `playroom`. Hedman, Philip, et al. *Deep Blending for Free-Viewpoint Image-Based Rendering*, SIGGRAPH Asia 2018. | Released by the authors for research use. |
| Training | Rendered with the reference implementation of 3D Gaussian Splatting — Kerbl, Kopanas, Leimkühler, Drettakis, *3D Gaussian Splatting for Real-Time Radiance Field Rendering*, SIGGRAPH 2023 — to 30 000 iterations. | The reference implementation is **non-commercial research use only**. |
| Conversion | `.ply` → `.splat` with [`tools/ply2splat.cjs`](tools/ply2splat.cjs), itself derived from the layout documented by [antimatter15/splat](https://github.com/antimatter15/splat); then `.splat` → SPZ v2 with [`tools/splat2spz.cjs`](tools/splat2spz.cjs), packed to the layout decoded by `@mkkellogg/gaussian-splats-3d`. SPZ itself is Niantic's format ([nianticlabs/spz](https://github.com/nianticlabs/spz)). | MIT (both converters in this repo; SPZ is MIT too). |

The 30k weights were obtained from a public Hugging Face mirror of the reference
implementation's outputs (`Voxel51/gaussian_splatting`). That mirror is no longer publicly
reachable, so the converted scene in this repository is the only copy shipped here —
it is a **converted dump of third-party research weights**, kept so the demo runs from a
clean clone.

**If you plan to use this commercially, replace the scene.** Capture your own room and train it
with a commercially-licensed pipeline; nothing else in this repository touches the weights.
To swap it, change `SCENE` in [`src/config.ts`](src/config.ts) — see the README.

The recorder that produced `media/preview.gif` drives this scene through the app's own
`?demo` mode, so the GIF is a real render, not a mock-up.

## The code this started from

[`rossning92/head-tracked-3d`](https://github.com/rossning92/head-tracked-3d) — MIT, 2021.
It is the fish-tank-window demo this repository is a rewrite of: a webcam, a face tracker and
a three.js scene whose camera follows your head.

What remains is the idea and the MIT licence. The tracking stack, the projection model, the
scene and the UI were replaced — the README has the full list of differences.

## Libraries

| Library | Version | Licence |
| --- | --- | --- |
| [three.js](https://threejs.org) | 0.169 | MIT |
| [@mkkellogg/gaussian-splats-3d](https://github.com/mkkellogg/GaussianSplats3D) | 0.4.7 | MIT |
| [@mediapipe/tasks-vision](https://github.com/google-ai-edge/mediapipe) | 0.10.18 | Apache-2.0 |
| [tweakpane](https://github.com/tweakpane/tweakpane) | 3.0.3 | MIT |
| [Vite](https://vitejs.dev) | 5.4 | MIT |
| [TypeScript](https://www.typescriptlang.org) | 5.5 | Apache-2.0 |

The face model itself (`face_landmarker.task`, ~3.7 MB) and the MediaPipe WASM runtime are
**not** bundled: they are fetched at runtime from Google's `storage.googleapis.com` and from
`cdn.jsdelivr.net`. A first load therefore needs network access; after that the browser cache
carries them.

## What is not in this repository

- The **Deep Blending** source images and camera poses (several GB).
- The training code and the original `.ply` (476 MB for this scene).
- The **Mip-NeRF360** `room` scene used by the very first version of this demo.

Only the converted 30.1 MB `.spz` and the 4.2 MB preview GIF are committed as binary data.

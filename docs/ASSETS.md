# Third-party assets and licences

Everything the app draws is made by this repository's own code: geometry is built in
JavaScript at run time, textures are baked on the GPU at start-up (`src/materials/`) or
painted into canvases by the modules, and all sound is synthesised with WebAudio
(`src/ride/audio/`). The only third-party material the app loads is listed under
**Shipped with the app**. Tools that run only at build time are listed separately; none of
their files are part of the app.

## Shipped with the app

| What | Where | Source | Licence |
|---|---|---|---|
| three.js r186 (renderer, maths, loaders) | `vendor/three/build/` | three.js release r186, vendored unmodified so the app runs without a build step | MIT, see `vendor/three/LICENSE` (copyright three.js authors) |
| three.js add-ons used by the app: `geometries/RoundedBoxGeometry.js`, `lights/SunLight.js`, `lights/SunLightShadow.js`, `utils/BufferGeometryUtils.js` | `vendor/three/addons/` | same release | MIT (three.js authors) |
| Human figures: 49 dressed characters (meshes, skeleton weights, LODs, hair strand cards) and their texture strips, about 33 MB (29.4 MB gzip geometry, 3.9 MB WebP strips) | `assets/humans_mh/` (`cast.json`, `cast.bin.gz`, `tex/*.webp`, the strand atlas in `albedo_5` / `alpha_5`) | Built in this repository by `tools/blender/mh_*.py` with the MPFB2 add-on (MakeHuman for Blender, v2.0.18) from the MakeHuman system assets (`makehuman_system_assets_cc0.zip`); fetched by `tools/mh_fetch.sh`, image `docker/Dockerfile.mh` | CC0 1.0 (public domain dedication of the MakeHuman system assets; the cast built from them is released the same way, recorded in `cast.json` `license`: 'Human figures: built with MPFB2 from the MakeHuman system assets (CC0 1.0)') |

The rest of `vendor/three/addons/` is the unmodified add-on tree of the same release. The
app does not load it. Third-party libraries in it keep their own licences, stated in each
file's header or README (for example `libs/draco` and `libs/basis`: Apache-2.0;
`misc/SculptGL.LICENSE.txt`: MIT).

### Not shipped as files
- **Fonts**: none. The interface uses the system font stack (`src/style.css`), and text
  painted into textures (signs, posters, prices) uses fonts installed on the viewer's
  system (for example Liberation Sans, Noto Sans Hebrew, DejaVu Sans, Arial), falling back
  to the generic families.
- **Images, HDR environments, sound files**: none besides the figures' WebP texture strips above. The sky and environment light are
  computed (`src/env/`), surface textures are procedural, audio is synthesised.

## Build-time tools (not part of the app)

| Tool | Used for | Licence |
|---|---|---|
| MPFB2 v2.0.18 (Blender add-on) and the MakeHuman system assets | building the human cast (`tools/blender/mh_build.py`, stages chars, hair, tex, export, preview) (`docker/Dockerfile.mh`, `tools/mh_fetch.sh`; the downloads go to the git-ignored `docker/mh/`) | MPFB2 code: GPL-3.0 (used as a tool only; none of its code is redistributed). System assets: CC0 1.0 |
| Blender 4.5 LTS, Node 24, `@gltf-transform/cli`, Python with numpy / scipy / Pillow, ImageMagick, ffmpeg | the tools image (`docker/Dockerfile`, `tools/dk`): asset scripts, checks, movie encoding (`tools/record.py`) | each under its own licence (Blender: GPL-2.0-or-later; gltf-transform: MIT; others: their upstream licences); nothing they contain is shipped |
| Google Chrome (headless) | screenshots and timing (`tools/shoot.py`, `tools/record.py`) | proprietary browser, not shipped |

## Reference photographs

`reference/*.jpg` and `reference/*.jpeg` are third-party photographs of a real street,
kept only as visual reference for judging the result side by side. They are never loaded
by the app, never used as textures or traced, and are not covered by this project's
licences: their copyright stays with their photographers and agencies. They must not be
redistributed with the app.

## Adding an asset

Record every new third-party file here before it is committed: what it is, where it lives,
where it came from (and the script that fetches or converts it), and its licence. Only
freely licensed material (CC0, CC-BY with attribution recorded here, MIT, BSD, Apache-2.0
or equivalent) may be shipped. Strip authoring metadata (glTF `generator` / `copyright`,
image EXIF / XMP) from generated files.

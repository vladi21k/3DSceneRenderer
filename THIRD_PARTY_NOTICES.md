# Third-party notices

This project's own work (all code in `src/`, `tools/`, `docker/`, `serve.py`, `index.html`,
the documentation and the screenshots in `docs/screenshots/`, and the human-figure files in
`assets/humans_mh/` built by this project's scripts) is licensed under the MIT License, see
[LICENSE](LICENSE).

It includes or builds on the third-party works below, which keep their own licences. Details
of what each one is used for are in [docs/ASSETS.md](docs/ASSETS.md).

## Included in this repository

| Work | Where | Licence |
|---|---|---|
| three.js r186 (renderer and add-ons; the app uses the core plus `geometries/RoundedBoxGeometry.js`, `lights/SunLight.js`, `lights/SunLightShadow.js` and `utils/BufferGeometryUtils.js`) | `vendor/three/` | MIT, Copyright © 2010-2026 three.js authors, see [vendor/three/LICENSE](vendor/three/LICENSE) |
| Libraries bundled inside the three.js add-on tree (not loaded by the app) | `vendor/three/addons/libs/`, `vendor/three/addons/misc/` | Their own licences, stated in each file's header or licence file, for example Draco and Basis Universal: Apache-2.0; SculptGL: MIT ([vendor/three/addons/misc/SculptGL.LICENSE.txt](vendor/three/addons/misc/SculptGL.LICENSE.txt)); fflate, lil-gui, meshoptimizer, stats.js, tween.js, ktx-parse and others: MIT or similar permissive licences |
| MakeHuman system assets (body, skins, eyes, eyebrows, eyelashes, hair and clothes) from which the human figures in `assets/humans_mh/` were built | built into `assets/humans_mh/` | CC0 1.0 (public domain dedication), [makehumancommunity.org](http://www.makehumancommunity.org/) |

## Used to build assets, not included

These tools are downloaded into local Docker images by `docker/Dockerfile` and
`tools/mh_fetch.sh`; none of their files are in this repository or shipped with the app.

| Tool | Licence |
|---|---|
| MPFB2 v2.0.18 (MakeHuman add-on for Blender), used to build the human figures | GPL-3.0; models it produces are not covered by the GPL |
| Blender 4.5 LTS | GPL-2.0-or-later |
| Node.js 24, `@gltf-transform/cli` | MIT |
| Python, numpy, scipy, Pillow | PSF / BSD-style licences |
| ImageMagick, ffmpeg | ImageMagick licence; LGPL-2.1-or-later / GPL |
| Ubuntu 24.04 base image | various open-source licences |
| Google Chrome or Chromium (headless capture tools) | proprietary / BSD-style; not shipped |

## Reference photographs (not included)

The reference photographs used to judge the renders are third-party images and are not part of
this repository. The `reference/` folder holds only a note: put your own reference photos there
(git ignores everything else in it). The app never loads them.

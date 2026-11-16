# 3D mascot sources

The sources of the 3D mascot drawn by the app (`app/src/components/mascot/three/`): the seven skulls, their fur,
visor and rig, and the accessories. Everything is procedural: each model is built by a Blender script from
numbers, with no sculpted or imported asset. These scripts are the form to edit; the `.blend` files and the JSON
exports are build outputs, rebuilt from them.

## What is here

| File | What it does |
|---|---|
| `blender/build_agent.py` | Builds one skull (`--shape`): the quad body and ears, shaped from the skull table (`SKULLS`, the same seven skulls as the app), the visor (same size on every skull), the eye atlas and about 150,000 fur strands. Writes `Agent_<shape>.blend`. |
| `blender/rig_agent.py` | Adds the light rig (body, top, ears) and the motion clips (hop, big hop, startle, grab, happy) to that `.blend`. |
| `blender/export_web.py` | Exports the rigged skull as `agent_<shape>.json`: body and light body meshes, fur and ear weights, bones, poses, visor. |
| `blender/build_accessories.py` | Models every accessory and the pieces some of them wear, in the units of their 2D drawings (`app/src/components/mascot/mascot-accessories.tsx`). Writes `Accessories.blend`, a contact sheet and `accessories.json`. |
| `blender/render_check.py` | Front and three-quarter renders of a skull, to check a build by eye. |
| `build-all.mjs` | Runs the whole chain: the seven skulls, the accessories, then `gen-data.mjs`. |
| `gen-data.mjs` | Quantises the exports into `app/src/components/mascot/three/agent-data.json` (positions on 16 bits, normals and weights on 8, poses in half floats). |

The 2D mascot is drawn from the same models: `app/scripts/gen-mascot-2d.mjs` reads `agent-data.json` and writes
`app/src/components/mascot/mascot-2d-data.ts`. Run it after a new `agent-data.json`.

## Rebuilding

Blender 4.4 and Node, on any system:

```bash
node tools/mascot-3d/build-all.mjs --blender <path to blender> --work <a folder outside the repository>
node app/scripts/gen-mascot-2d.mjs
```

`--skip-renders` leaves out the check renders. A full build takes a few minutes. The chain is deterministic (the
fur strands use a fixed random seed): unchanged scripts give back `agent-data.json` byte for byte. To
check the quantisation alone, run `node tools/mascot-3d/gen-data.mjs <work>/exports`.

## Provenance and licence

Every model here (the seven skulls, their fur, visor, eyes atlas and rig, and every accessory) was created for
Timon by its contributors, from scratch, with these scripts; they use no third-party model, texture or asset pack.
They were first contributed in pull request #49. Like the rest of the repository, these scripts and the models
they produce are under the GNU Affero General Public License (see `LICENSING.md`).

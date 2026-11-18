# Fusion720

An open-source, browser-based **parametric CAD modeller** with a real B-rep geometry kernel
(OpenCascade) and a clean, keyboard-friendly interface. No install, no account, no build step.

> Fusion720 is an independent project and is not affiliated with or endorsed by Autodesk.
> "Fusion" and "Fusion 360" are trademarks of Autodesk, Inc.

## Run it

**Windows (no Node or Python needed):** double-click `start.bat`, or run:

```bash
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Then open <http://localhost:8720>.

**Anything else:** serve this folder with any static web server (for example `npx serve .` or
`python -m http.server 8720`). Open `index.html` through the server — opening it straight from
disk (`file://`) won't work because browsers block module workers there.

The first visit downloads the OpenCascade kernel (~23 MB) from jsDelivr; after that it is cached
and starts in well under a second.

## Publish on GitHub Pages

There is no build step — the repository *is* the website.

1. **Create a repository** on GitHub (for example `fusion720`). Make it **public** — Pages on a free
   account only publishes public repositories.
2. **Add the files** — either way works:
   - *No Git needed:* on the empty repository page choose **uploading an existing file**, drag in
     everything from this folder (`index.html`, `src`, `styles`, `tests`, `README.md`, `LICENSE`,
     `serve.ps1`, `start.bat`, `.nojekyll`), then **Commit changes**. If your browser leaves out
     `.nojekyll`, that's fine — the site still works.
   - *With Git:*
     ```bash
     git init
     git add .
     git commit -m "Fusion720"
     git branch -M main
     git remote add origin https://github.com/<your-username>/<your-repo>.git
     git push -u origin main
     ```
3. **Turn on Pages:** repository **Settings → Pages → Build and deployment → Source: Deploy from a
   branch**, pick **main** and **/ (root)**, then **Save**.
4. About a minute later the app is live at `https://<your-username>.github.io/<your-repo>/`.
   Every new commit republishes it automatically.

Notes: all paths are relative, so it runs from any sub-folder or custom domain. Each visitor's
designs autosave in their own browser; nothing is uploaded anywhere. The kernel smoke test is at
`…/tests/kernel.html`.

## What it does

| Area | Features |
| --- | --- |
| **Sketching** | Line / polyline (click the first point to close), 2-point and center rectangles, circles, polygons, slots, construction geometry, grid + point snapping with horizontal/vertical inference, **type-to-dimension** while drawing (digits, `Tab`, `Enter` — parameter names work too), editable dimensions as expressions |
| **Constraints** | Built-in geometric solver: Coincident, Horizontal/Vertical, Parallel, Perpendicular, Tangent, Equal, Concentric, Midpoint, Collinear, Symmetric, Fix. Driving dimensions (length, distance, point–line distance, angle, diameter, position) via the Dimension tool or by clicking any dimension. Snapping and typed values add constraints automatically. Geometry is colour-coded (blue = free, white = fully defined, green = fixed, red = conflict), the inspector shows remaining degrees of freedom, conflicting constraints are refused, and dragging re-solves live |
| **Profiles** | Automatic region detection — nested shapes become holes; click shaded regions to pick them |
| **Solids** | Extrude (one side / symmetric / two sides; new, join, cut, intersect), Revolve (sketch axes or any sketch line), Box, Cylinder, Sphere, Torus |
| **Modify** | Fillet, Chamfer, Shell, Combine, Move / Copy (translate + rotate), Mirror, Rectangular & circular Pattern, Remove |
| **Parametric** | Full feature timeline with rollback marker, edit any feature later, suppress, delete, live preview while editing; user **Parameters** with units (`mm cm m in ft deg`) and math (`sin cos sqrt min max …`) usable in every field |
| **Robust references** | Fillet / chamfer / shell selections are stored with geometry type, adjacent-face signature and bounding-box-relative position, so they survive most upstream dimension changes |
| **Inspect** | Measure (snaps to edge ends/midpoints), section view, volume / area / mass / size per body |
| **View** | View cube, home / standard views, fit, perspective ↔ orthographic, shaded / edges / wireframe, adaptive infinite grid, light & dark themes |
| **Files** | Autosave in the browser, save/open `.f720.json` (plain JSON, diff-friendly), export **STEP** (to other CAD tools) and **STL** (3D printing), drag-and-drop a design onto the window |
| **UX** | Command palette (`S` / `Ctrl K`), contextual floating toolbar, non-modal inspector with live preview, undo/redo for everything, right-click menus, panels that collapse for a bigger viewport |

### Mouse & keys

| Action | Input |
| --- | --- |
| Orbit | Right-drag, or left-drag on empty space |
| Pan | Middle-drag, or Shift + right-drag |
| Zoom | Wheel (zooms to the cursor) |
| Search every command | `S` or `Ctrl K` |
| Extrude / Revolve / Fillet / Move / Box / Measure | `E` / `V` / `F` / `M` / `B` / `I` |
| Sketch tools | `L` line, `R` rectangle, `Shift R` center rectangle, `C` circle, `P` polygon, `O` slot, `X` construction |
| Sketch constraints | `D` dimension, `H` horizontal/vertical, `T` tangent; click a glyph to select it, right-click a glyph or dimension to delete it |
| Finish sketch | `Ctrl Enter` |
| OK / Cancel a feature | `Enter` / `Esc` |
| Undo / Redo | `Ctrl Z` / `Ctrl Y` |
| Home view / Fit | `Home` / `F6` |
| All shortcuts | `?` |

## How it is built

Plain ES modules — no bundler, no framework. Edit a file, refresh the page.

```
index.html              app shell + import map (three.js from jsDelivr)
styles/app.css          design tokens (light/dark) and all UI styles
src/main.js             bootstrap: wires viewport, kernel, panels, shortcuts
src/app.js              controller: document, undo/redo, commands, picking, rebuild orchestration
src/model/              pure data + math (shared with the worker)
  expr.js               safe expression evaluator with units and parameters
  profiles.js           sketch entities, outlines, profile/region detection
  constraints.js        sketch constraint solver (Levenberg–Marquardt) + degrees-of-freedom analysis
  features.js           feature registry: defaults + inspector field specs
  geom.js               vectors and sketch-plane frames
  example.js            the example bracket
src/kernel/
  worker.js             OpenCascade (via replicad) in a Web Worker: rebuilds the
                        timeline with per-feature caching, meshes bodies, exports
  client.js             promise RPC that coalesces rebuilds while you drag values
src/viewer/
  viewport.js           three.js scene, camera, picking (faces/edges/profiles), highlights
  sketcher.js           2D tools, snapping, inference, type-to-dimension HUD
  grid.js, viewcube.js  shader grid and orientation cube
src/ui/                 toolbar, browser tree, inspector, timeline, palette, parameters dialog
tests/kernel.html       kernel smoke test (open it through the server)
```

**Data flow:** every edit produces a new JSON document → the worker re-evaluates only the features
after the first changed one (hash-chained cache) → meshes come back → the viewport swaps only the
bodies whose geometry changed. The UI thread never blocks on geometry.

### Design file format

A design is one JSON object: `params` (name + expression), an ordered `features` list (sketches hold
their entities with expression-valued dimensions), the timeline `marker`, and per-body appearance.
See `src/model/example.js` for a complete, readable example.

## Honest limitations

This is a strong foundation, not feature parity with a commercial CAD suite (yet):

- The sketch solver is a numeric least-squares solver: robust for typical part sketches (dozens of entities), but not tuned for very large sketches, and rectangles stay axis-aligned (use a closed line chain for rotated boxes).
- No arcs/splines inside polylines, no sketch fillets, no projecting edges into sketches.
- Sketches on faces are placed at the face's position when created; they don't follow the face if it moves.
- Edge/face references use smart heuristics, not full topological naming, so big topology changes can still break a fillet (it shows a clear error and you can re-pick the edges).
- No assemblies/joints, drawings, CAM, simulation or cloud collaboration.
- Needs internet on first load (three.js and the kernel come from jsDelivr). To run fully offline, vendor those files locally and update the URLs in `index.html` and `src/kernel/worker.js`.

## Roadmap ideas

Arcs + sketch fillets, project/offset in sketches, hole & thread
features, sweep and loft UI, press-pull on faces, assemblies with joints, 2D drawings, fully offline
build, and PWA install.

## License

MIT — see [LICENSE](LICENSE).

Third-party components loaded at runtime: [OpenCascade](https://dev.opencascade.org/) via
[replicad-opencascadejs](https://github.com/sgenoud/replicad) (LGPL-2.1), [replicad](https://github.com/sgenoud/replicad) (MIT),
[three.js](https://threejs.org/) (MIT), Inter and JetBrains Mono fonts (OFL).

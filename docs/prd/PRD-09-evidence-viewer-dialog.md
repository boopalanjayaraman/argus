# PRD-09 — Evidence Viewer Dialog (Argus)

Status: Implemented (2026-11-03) — photo/video/3D viewers verified by screenshot; Simulator PLY stride bug found and fixed under this PRD · Source: Spec §4 (extends PRD-05 viewers) · Tech Stack §§5,7 · Depends on: PRD-04, PRD-05

## Specs

Clicking an evidence pane (or its expand icon) on the Live session page opens a
large viewer dialog over the session. The session behind it keeps polling; the
dialog never changes inspection state.

- **Photographs:** clicking a photo thumbnail (in the pane or Documents tab is
  unchanged) opens the full-resolution image. Prev/next arrows step through
  the session's photographs. Filename and position (`2 of 6`) are shown.
  Arrow keys work; Esc closes.
- **Video:** clicking the video pane (outside the native controls) or its
  expand icon opens the latest video segment in a dialog with native
  play/pause, seek, and volume controls, autoplay muted off.
- **3D laser point cloud:** clicking the point-cloud pane or its expand icon
  opens an interactive 3D viewer merging **all received PLY chunks** of the
  session: drag to orbit, scroll/pinch to zoom, right-drag (or two-finger
  drag) to pan. A Reset view button restores the fitted view. The header
  shows chunk count and rendered point count; chunk count is never presented
  as coverage. Points keep their scanned RGB colors.
- **Empty states:** with no evidence of a modality, the pane keeps its
  existing empty state and no viewer opens.
- **Dialog chrome:** follows the design system (`ar-scrim` + surface panel,
  `ar-btn` controls, design tokens only). Close via × button, Esc, or
  clicking the scrim. No new page, no route change.

Amendment (2026-11-03, user request): the video viewer plays all segments
merged into one continuous video (`GET /api/v1/inspections/:id/video/merged`,
ffmpeg concat in stream order, cached per chunk signature, HTTP Range for
seeking; viewer falls back to the last segment if merging is unavailable).

Amendment (2026-11-03, user request): the CAD pane gets the same viewer
dialog — expand icon opens the Argus-generated CAD reference cloud
(`reference.ply?sample=200000`) in the identical interactive viewer
(orbit/zoom/pan, Reset view, uniform reference colour).

Out of scope: CAD/scan overlay or registration in one view (needs validated
registration, PRD-07), point-cloud editing/measurement tools, video segment
playlist stitching.

## Technical Specs

- **Pattern:** one `ViewerDialog` component in the web app, discriminated by
  `kind: 'photo' | 'video' | 'pointcloud'`; opened from pane expand buttons
  and photo thumbnails. Rendering never blocks on inference (PRD-05 rule).
- **3D:** Three.js (`three@0.170.0`, pinned) `WebGLRenderer` + `Points` with
  vertex colors; `OrbitControls` from `three/addons`. No React Three Fiber —
  one imperative canvas inside the dialog lifecycle (mount/unmount dispose:
  renderer, geometries, controls).
- **PLY parsing:** own parser (`pointcloud.ts`) for `ascii` and
  `binary_little_endian` PLY with x/y/z float + optional uchar RGB; unknown
  properties are skipped by stride. Merging samples with a deterministic
  stride to a cap of 300,000 rendered points so 16 × 50k chunks stay
  interactive; the dialog states the rendered count.
- **Data:** existing evidence file endpoint
  `GET /api/v1/inspections/:id/evidence/:evidenceId/file`; chunks are fetched
  in parallel, failures of a single chunk are tolerated and reported in the
  dialog (`N of M chunks loaded`).
- **Configuration:** `VIEWER_POINT_CAP` (default 300000) as a module constant;
  point size attenuation on, initial camera fitted to the merged bounding box.

## Acceptance

- [ ] Photo viewer opens from a thumbnail, steps prev/next, closes on Esc.
- [ ] Video viewer plays the stored segment with working seek.
- [ ] Point-cloud viewer renders merged chunks in color; orbit/zoom/pan and
      Reset view work; header shows chunks loaded and points rendered.
- [ ] Panes with no evidence open nothing; dialog never mutates session state.
- [ ] `npm run check:ux` passes (no invented classes); design tokens only.

## References

- Spec: [Argus_Spec.md](../specs/Argus_Spec.md) §4 · Agentic: [Argus_Agentic_Architecture.md](../architecture/Argus_Agentic_Architecture.md) §3
- UX: [Main.dc.html](../ux/Argus%20click-through-html/Main.dc.html) session artboard + `bundle.css` (`ar-scrim`, `ar-dialog` patterns); replicate values, don't ship markup.
- Builds on: [PRD-05](PRD-05-live-session-sse-and-viewers.md) (panes), [PRD-04](PRD-04-evidence-ingestion-api.md) (evidence files).

## Test Plan (write before implementation — tests fail first)

- Unit (web vitest): PLY parser reads a generated binary_little_endian PLY
  (x/y/z + RGB + extra uchar props) to exact positions/colors; ascii PLY
  parses; malformed header throws; sampling stride keeps ≤ cap points and
  is deterministic.
- UI (headless Chrome): open each viewer from its pane, screenshot; point
  cloud canvas is non-blank and changes pixels after a drag; Esc closes.
- Negative: dialog on a Waiting session (no evidence) never opens.

## Verification (after implementation)

- [ ] Run this PRD's full test list + Acceptance above.
- [ ] Headless screenshots of all three viewers on a streamed session. No test red/skipped.

## Review gate

Approved in the user's request of 2026-11-03 ("implement a viewer popup …
Include this to a PRD or create a new PRD"). Edit this file to change scope.

# PRD-11 — Analyzed Video: Tracked Parts and Possible Issues (Argus)

Status: Implemented (03 Nov 2026, user request) · **Display only** · Source: Spec §4.2 (video panel), §9 · Depends on: PRD-07, PRD-09, PRD-10

## Problem

Findings live in tables. On the video, an inspector cannot see *where* a possible issue is: which flange, which bolts. SAM 3.1 can follow parts through a video; the findings already say which part each rule concerns. Joining the two lets the video point at the parts with possible issues while it plays.

## Specs

- **Two tabs in the video viewer dialog:** **Original video** (the existing merged-video player, unchanged) and **Analyzed video** (new). No existing pane or view changes. Deep link `#session/<id>/video-analyzed` opens the dialog on the new tab.
- **Analyzed video** plays the same merged video with an overlay:
  - parts the session's FAIL / WARNING findings concern get a box that follows the part frame by frame, with up to two short labels: `Rule 4.7 · Possible issue: flange face exposed bare metal, no protector cover visible` (FAIL) or `… · Worth a look: …` (WARNING); more than two → `+N more in findings`;
  - labels are worded lightly and come from the model's own note in the finding, trimmed to ~64 characters; no new judgement is added;
  - **Show all tracked parts** toggles dashed boxes for every part SAM followed;
  - a footer says these are hints from the findings, not verdicts, and **Check the findings** closes the dialog and opens Applicable Rules.
- **Display only:** tracking never creates or changes a finding, never holds the session in ANALYZING, and is not drained or cancelled by End Inspection / Terminate Now. It may run on a closed session (it only adds an overlay).
- **When it runs:** automatically when the producer sends `/complete`; on demand with **Analyze video** (or **Re-analyze** when new video arrived after the last run).
- **Instances:** a finding names a part type ("flange face"), not an instance, so its label is drawn on every tracked instance of that part.

Out of scope: per-instance attribution (would need the model to localise the issue), burned-in annotated MP4 export, motion analysis.

## Technical Specs

- **Inspection service:** `media.analysis_proxy` makes a 5 fps (`VIDEO_TRACK_FPS`), ≤1280 px, faststart copy of the merged video — SAM video is billed per frame, and frame *n* of the proxy is at *n*/fps seconds of the original. `meta_adapter.track_video` uploads it once (Files API), runs one SAM 3.1 concept request per relevant component in parallel (`input_video` + `file_id`, streaming, `include_confidence`), parses with `meta_sam_parser.video_segmentation_format` into per-object box tracks `[frame, left, top, right, bottom, confidence]`, cached by (proxy sha256, concept, model). `POST /track-video {sessionId, url, family, type, rules}` returns `{fps, width, height, duration, components[{id, prompt, objects}], componentRules}`; components = routing components with at least one pinned rule (PRD-10).
- **API:** queue kind `tracking` (concurrency 1, excluded from lifecycle / drain / cancel). Result stored as observation `kind: video_tracks` with the video signature. `POST /api/v1/inspections/:id/track-video` (409 `NO_VIDEO` without video); `GET /api/v1/inspections/:id/video/annotations` → `{status, fps, width, height, components, labels[{componentId, ruleId, rule, title, status, text}], current}`. Labels are joined **at read time** from the latest findings, so they follow revisions and the frozen state after closure.
- **Web:** `AnalyzedVideo` in `ViewerDialog.tsx`; SVG overlay in the proxy's pixel frame over an aspect-locked video box; boxes interpolated between samples ≤0.6 s apart (`annotations.ts` `boxAt`), hidden outside a part's track.
- **Measured (03 Nov 2026, finished-valve clip, 30 s → 151 proxy frames):** nameplate tracked in 113 frames at 0.94 confidence; flange faces 131 + 28 frames; bonnet bolts 3 objects.

## Acceptance

- [x] Original video unchanged; Analyzed video tab shows tracked boxes with possible-issue labels for FAIL/WARNING findings only.
- [x] Tracking does not delay READY_TO_CLOSE or closure; works on closed sessions.
- [x] Recorded live SAM video stream parses into stable per-object tracks.
- [ ] Manual: play the analyzed video of a finished-valve session and check labels sit on the right parts.

## Test Plan

- pytest: parse a recorded SAM 3.1 video stream (fixture) into sorted per-object frame tracks.
- Vitest (API): label wording and joining (FAIL/WARNING only, tracked parts only); `/complete` → tracking → annotations ready, session still reaches READY_TO_CLOSE; 409 without video.
- Vitest (web): `boxAt` interpolation, gap handling.

## Review gate

Approved by the user on 03 Nov 2026 ("attach the annotations as a new video view as a tab in the dialog … display only … word them lightly"). Edit this file to change scope.

# Inspection - CAD Scan Conformance
Source: Argus demonstration acceptance values, approved by the project owner on 03 Nov 2026 for the hackathon demo only (DEMO_ONLY). Not OEM, ASME or customer tolerances; replace with the purchase specification's values for real use.
Evidence: laser point cloud of the assembled valve, merged from all received chunks, registered to the pinned CAD by ICP. Units mm. Deviation is the signed point-to-plane distance along the CAD surface normal.
GEO-001: The merged scan registers to the pinned CAD with ICP fitness of at least 0.90 and covers at least 80% of the CAD surface. Lower coverage = INSUFFICIENT_EVIDENCE for every scan rule, never PASS.
GEO-002: RMS surface deviation of the registered scan from the CAD is at most 3.0 mm. Above 3.0 mm = FAIL.
GEO-003: 95th-percentile absolute surface deviation is at most 6.0 mm, so no local region departs grossly from the CAD. Above 6.0 mm = FAIL.

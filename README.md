# argus
**Autonomous, continuous inspection AI for engineer-to-order (ETO), high-mix low-volume industrial manufacturing.**

ETO equipment — severe-service valves, custom pumps, turbomachinery — is built one unit at a time, often $50,000–$1,200,000+ each. There is no batch to sample and no history of defects to train on: every unit must be checked against its own design.

Argus does not wait for a single final inspection before delivery. It inspects the same asset **continuously, at every stage of the build** — raw casting, machining, sub-assembly, final assembly, finish and nameplate, test and dispatch — each time against **the CAD and the rules for that stage**, while evidence streams in:

- **Live evidence:** camera video, close-up photographs and 3D laser scans, analysed as they arrive.
- **Design intent, not training data:** observations are compared with the stage's CAD and with numbered rules from standards, works instructions and the customer's work order.
- **Meta models where they help, deterministic checks where it matters:** SAM 3.1 finds and tracks valve parts; Muse Spark and Muse Wonder read them against the pinned rule; laser-scan geometry is measured against the CAD; a deterministic rule gate — not a model — decides every verdict.
- **A traceable record per stage:** findings with cited rules, evidence and hashes, frozen into a dossier for human review — so issues are caught at the stage where they are cheapest to fix, not at teardown.

The hackathon demo inspects one 48-inch swing check valve at two stages (during build, and finished: painted and nameplated) with an independent simulator streaming the evidence.

More: [product pitch](docs/product_pitch.md) · [feature spec](docs/specs/Argus_Spec.md) · [architecture](docs/architecture/Argus_Agentic_Architecture.md) · [PRDs](docs/prd/README.md) · [folder structure](docs/folder-structure.md)

### The Problem: When Batch Size Is Exactly One

In heavy manufacturing—such as severe-service process valves, custom pumps, and turbomachinery—equipment is engineered to order (ETO) for extreme pressures, temperatures, or corrosive environments. A single unit regularly costs between **$50,000 and $1,200,000+**.

In this environment, statistical sampling (inspecting 5 parts out of 100) is invalid; every single asset requires 100% deterministic verification against custom engineering drawings.

---

### Why Existing Solutions Fail in ETO

#### 1. Why CTO (Configure-to-Order) Systems Don’t Work Here

Most automated quality systems in industry are designed for **Configure-to-Order (CTO)**. CTO is a *modular assembly verification* problem. The system checks whether a standard catalog body was paired with the correct pre-defined actuator, flange size, or positioner listed in the Bill of Materials (BOM).

ETO is a custom geometry and physics problem. The valve body casting is often custom-forged with non-standard wall thicknesses, proprietary anti-cavitation trim geometry, unique weld preps, and tailored face-to-face dimensions designed from scratch for a single facility. A CTO rule-engine cannot inspect these assets because there is no static component catalog or standard baseline to evaluate against.

#### 2. Why Conventional Vision AI Breaks Down

Standard deep learning models (like YOLO or defect classification networks) rely on the big-data paradigm: they require thousands of images of "good" parts and thousands of historical defect examples to train. In ETO, **batch size is one**. The asset has never existed before, meaning zero historical training images exist prior to production.

#### 3. The Metrology Bottleneck Today

Modern plants already invest heavily in high-end metrology—such as handheld 3D blue-laser scanners, portable coordinate measuring machine (CMM) arms, and digital travelers. However, the process remains heavily semi-manual and disjointed:

* A quality engineer must manually import the unique 3D CAD model into metrology software.


* The technician must manually align the captured 3D point cloud onto the design model to compute surface deviations.


* Automated robot inspection cells cannot be easily deployed because every new shape requires manual trajectory programming to avoid collisions.



---

### The Cost of Late-Stage Failure

When an internal geometric mismatch, incorrect seat alloy, or porosity slips through, the cost escalates exponentially:

* **At Factory Acceptance Testing (FAT):** Catching a defect after the unit is fully assembled requires quarantine, complete teardown, scrap of single-use seals, and re-machining—costing **$150,000+** in lost capacity, labor, and contractual delay penalties.


* **In the Field (Catastrophic Blowout):** If a custom valve fails under 2,500 psi superheated steam in an operating plant, total event losses routinely exceed **$50,000,000**:


* **$35,000,000** in unplanned downtime ($1M to $2.5M per day over weeks of outage).


* **$8,000,000** in collateral equipment and piping damage.


* **$5,000,000+** in regulatory fines and environmental penalties.


* **$2,500,000** in insurance deductibles and legal defense.





---

### What We Are Building: Argus

**Argus** is a blueprint-driven visual inspection brain designed specifically for high-mix, zero-training-data environments.

Instead of training on historical defects, Argus inspects against **Design Intent** by bridging spatial perception with engineering standards:

* **Ingesting Context (Muse Wonder):** Directly processes customer design requirements, CAD metadata, and full 200+ page manufacturer works standards (e.g., DIN/ASME specifications, 1.1.1 assembly instructions derived from a german OEM Manufacturer) inside a 1-million-token context window.


* **Zero-Shot Perception (SAM 3.1):** Segments complex metallic scenes without prior training—isolating stamped metal nameplates, raised casting reliefs, weld seams, and dynamic bubble releases under water.


* **Deterministic Verification (Muse Spark):** Compares physical coordinates against CAD boundaries, validates GD&T tolerances, checks torque sequences, and calculates bubble leak rates via explicit code execution rather than LLM guesswork.



---

### Shifting Left: Progressive Quality Gates

Rather than serving as a single final inspection checkpoint, Argus operates across manufacturing milestones to catch discrepancies when they are cheapest to resolve:

```
[ Gate 1: Intake / Raw Casting ] ──► [ Gate 2: In-Process Assembly ] ──► [ Gate 3: Acceptance Testing ]
  Cost to resolve: ~$1,000             Cost to resolve: ~$5,000            Cost to resolve: ~$150,000+
  (Reject raw casting before CNC)      (Rework seat weld/fasteners)        (Full teardown & re-test)

```

1. **Gate 1 (Raw Casting & Machining Intake):** Scans the incoming casting against the CAD model before machining starts, catching dimensional shortages or casting voids before wasting 40 hours of CNC milling ($1,000 fix).


2. **Gate 2 (In-Process Assembly & Fasteners):** Verifies internal seat ring alloy markings, tool part numbers, and stud bolt grades (`ASTM A193 B7`) before the bonnet is torqued shut ($5,000 fix).


3. **Gate 3 (Unattended Test Cell):** Operates inside enclosed pressure bays to track ASME Class VI submerged bubble leak rates and stem stroke travel automatically while the technician steps away ($150,000+ saved).



---

### The ROI

* **90% Cycle Time Reduction:** Compresses inspection and cross-referencing from 45–60 minutes of manual alignment down to **4–6 minutes** of automated verification.
* **Teardown Elimination:** Prevents internal component mismatches before units are sealed, protecting final-assembly throughput.


* **Instant Digital Dossier:** Auto-generates a cryptographically signed As-Built Inspection Dossier with cropped image evidence and video timestamps, eliminating weeks of paperwork lag to release shipping holds immediately.
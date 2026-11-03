# Inspection - Nameplate and Tagging
Source: Assembly Sheets 1-4. Nameplate P/N 0190-3581
NP-001: At final inspection, nameplate must be present and stamped. Absent/unstamped = FAIL.
NP-002: Nameplate must be riveted to the pre-drilled yoke location, on the yoke on the same side as the body casting markings. Else FAIL.
NP-003 Serial format: ^C-\d{4}-\d{1,2}\.\d{1,2}$
  C = assembled in Canada. Digits 1-4 = work order number.
  Before decimal = item/line number. After decimal = unit number within that item.
  Example: C-1234-5.6 = WO 1234, item 5, 6th identical valve.
  Format mismatch, or WO segment != work order number = FAIL.
NP-004 Pos.1 Valve Type must be in: 3241,3244,3245,3248,3249,3251,3253,3254,3255,3256,3258,3281,3284,3286,3347. Else FAIL.
NP-005 Pos.2 Version Index must match ^\d{2}$ (00,01...). Else FAIL.
NP-006 Pos.3 Body Material known values: A126 Cl.B, A351 CF8M, A352 LC3, A216 WCB, A352 LCB. Open-ended list. Value outside list and not verified on work order = HOLD.
NP-007 Pos.5 Size must be numeric inches and equal work order size. Else FAIL.
NP-008 Pos.6 ANSI Class must be in: 125,150,250,300,600,900,1500,2500. Else FAIL.
NP-009 Pos.7 Cv must equal work order Cv and satisfy inspection_02 if Type 3241. Else FAIL.
NP-010 Pos.8 Characteristic: EP=Equal Percentage, LN=Linear, OC=On/Off. Else FAIL.
NP-011 Pos.9 Sealing must be in: ME=Metal/Metal, M3=Metal 316SS, M4=Metal 410SS, ST=Surface Stellite, FS=Plug Full Stellite / seat surface Stellite, HC=Hastelloy C, MO=Monel, ZN=Zirconium, PT=PTFE soft seal plug 316SS. Else FAIL.
NP-012 Pos.10 Trim must be in: 1=Flow divider St I, 3=Flow divider St III, B=Balanced no seal ring indication, BP=Balanced PTFE seal ring, BG=Balanced Graphite seal ring, B1=Balanced + divider I, B3=Balanced + divider III. Else FAIL. 1/B1 must use StI Cv table. 3/B3 must use StIII Cv table. Else FAIL.
TAG-001: If ASME B16.34 / B31.3 applicable, a stainless tag riveted or wired to the valve stating "Max. Press <N> psi @ 100°F" is required. Absent = FAIL.
  Only verified combinations in source:
    2in, Class 300, A351 CF8M -> 720 psi @ 100F
    1in, Class 1500, A216 WCC -> 3750 psi @ 100F
  Any other combination = HOLD, reason REQUIRES_EXTERNAL_PRESSURE_TABLE.
CRN-001: If final destination is Canada, CRN label is required, permanently affixed to body, bonnet, or extension (not yoke/actuator only), showing CRN 0C4462.52 and "Assembled In Canada". Absent/wrong location = FAIL. Not Canada = N_A.

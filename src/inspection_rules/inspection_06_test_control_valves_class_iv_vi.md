# Inspection - Test Control Valves Series 240/250, Class IV / VI
Source: Test Sheets 6-8, per ASME/FCI 70-2. Air 50-125F, full thrust by spring or air.
Setup: required actuator mounted and adjusted, flow direction correct.
Closing: fail_close = remove signal (spring closes). fail_open = apply supply pressure stated on work order. Missing fail_action/supply pressure = HOLD.
External tightness: valve open/partially open, 4 bar air. Sight glass, or leak fluid on packing and bonnet/body seams. PASS iff bubbles == 0.
## Class IV
Test pressure = lesser of 3-4 bar or max inlet pressure P1. P1 not on work order = HOLD.
Rotameter ranges L/H: 1.6-16, 8-80, 50-500, 160-1600, 1000-10000 at 1.293 kg/m3, 1 atm, 20C.
Source tolerance on limit: +/-10%. Inspection PASS requires measured < nominal limit.
Limits NL/h by Cv: 0.12:0.8, 0.2:1.2, 0.3:1.9, 0.5:3.1, 0.75:4.8, 1.2:7.7, 2:12.3, 3:19.2, 5:30.8, 7.5:48.5, 12:77, 20:123, 30:192, 40:269, 47:308, 75/70:485, 95:616, 120:770, 190:1230, 235:1540, 290:1920, 305:2000, 420:2770, 735:4850, 1150:7700, 1730:11500, 2300:15400, 2900:19200
Cv not in table = HOLD. Do not interpolate.
## Class VI
Test pressure = lesser of 3.5 bar or max P1.
Bubble method: 1/4in tube, 0.032in wall, submerged 1/8-1/4in in water, axis perpendicular. Count bubbles for 1 min starting after first bubble.
Volume method: inverted graduated beaker, ml/min = ml collected / minutes.
Limits by seat diameter mm [mL/min (NL/h), bubbles/min]:
  24:0.15(0.01),1 | 38:0.30(0.02),2 | 50:0.45(0.03),3 | 63:0.60(0.04),4
  80:0.90(0.05),6 | 100:1.70(0.10),11 | 150:4.00(0.24),27 | 200:6.75(0.40),45
PASS iff measured <= limit for method used. Seat diameter not in table = HOLD.

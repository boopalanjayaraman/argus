# Inspection - Agent Contract
## Required Inputs
work_order_number, valve_type, version_index, body_material_astm,
serial_number_stamped, nominal_size_in, ansi_class, cv_rated, kvs_rated,
flow_characteristic [EP|LN|OC], sealing_code, trim_option_code,
seat_material [410|316], seat_bore [max|reduced|all], flow_divider [none|StI|StIII],
destination_canada, asme_pressure_tag_applicable,
fail_action [fail_close|fail_open], leakage_class [IV|VI],
seal_type [metal|PTFE|EPDM], actuator_effective_area_cm2,
seat_torque_nm, bonnet_torque_nm, torque_wrench_calibration_valid,
external_bubbles, internal_leakage_nl_h, internal_leakage_ml_min,
internal_leakage_bubbles_min, test_pressure_bar
## Output Per Rule
rule_id, result [PASS|FAIL|HOLD|N_A], measured, limit, source_sheet, evidence, reason
reason is mandatory for FAIL and HOLD.
## Global Rules
G-001: No PASS without the evidence listed for that rule.
G-002: Blank source cell = HOLD, reason NOT_SPECIFIED_IN_SOURCE.
G-003: Source list ending in "etc." = open list. Unknown value = HOLD, not FAIL.
G-004: All torque checks require torque_wrench_calibration_valid == true, else HOLD.
G-005: Every test result must be recorded on the work order. Missing record = HOLD.

"""Dossier PDF (ReportAgent): the frozen inspection report as a printable PDF.

Built from the structured dossier the Argus API freezes at closure — the
same facts as the HTML dossier: outcome, reference baseline (CAD, rule
snapshot, order document, hashes), per-rule results with pinned citations,
scan metrics, incomplete analysis and the evidence register. Nothing here
decides anything; it only lays out what the API sends.
"""
from __future__ import annotations
import io
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

INK = colors.HexColor("#12141C")
MUTED = colors.HexColor("#4D5365")
LINE = colors.HexColor("#CCCCDD")
HEAD_BG = colors.HexColor("#EEF0F6")
STATUS_COLORS = {"PASS": "#0B6B4B", "WARNING": "#7A4900", "FAIL": "#8E2318", "INSUFFICIENT_EVIDENCE": "#1F5C8A",
                 "NOT_INSPECTED": "#4D5365", "NOT_APPLICABLE": "#4D5365", "ANALYZING": "#1F5C8A"}
OUTCOME_BG = {"PASS": "#0B6B4B", "WARNING": "#FFB547", "FAIL": "#8E2318", "INCONCLUSIVE": "#2E3A73", "PENDING": "#2E3A73"}
STATUS_ORDER = {"FAIL": 0, "WARNING": 1, "INSUFFICIENT_EVIDENCE": 2, "PASS": 3, "NOT_INSPECTED": 4, "ANALYZING": 2}

_base = getSampleStyleSheet()
H1 = ParagraphStyle("h1", parent=_base["Title"], fontSize=18, leading=22, alignment=TA_LEFT, textColor=INK, spaceAfter=2)
H2 = ParagraphStyle("h2", parent=_base["Heading2"], fontSize=11.5, leading=14, textColor=INK, spaceBefore=10, spaceAfter=4)
BODY = ParagraphStyle("body", parent=_base["BodyText"], fontSize=8.5, leading=11, textColor=INK)
SMALL = ParagraphStyle("small", parent=BODY, fontSize=7.2, leading=9.2)
MUTE = ParagraphStyle("mute", parent=SMALL, textColor=MUTED)
CELL = ParagraphStyle("cell", parent=SMALL)


def _p(text, style=CELL) -> Paragraph:
    return Paragraph(escape(str(text if text is not None else "")).replace("\n", "<br/>"), style)


def _status(status: str) -> Paragraph:
    label = {"INSUFFICIENT_EVIDENCE": "Insufficient evidence", "NOT_INSPECTED": "Not inspected",
             "NOT_APPLICABLE": "Not applicable"}.get(status, (status or "").title())
    return Paragraph(f'<font color="{STATUS_COLORS.get(status, "#4D5365")}"><b>{escape(label)}</b></font>', CELL)


def _table(rows, widths, header=True) -> Table:
    t = Table(rows, colWidths=widths, repeatRows=1 if header else 0)
    style = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("GRID", (0, 0), (-1, -1), 0.4, LINE),
             ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
             ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]
    if header:
        style += [("BACKGROUND", (0, 0), (-1, 0), HEAD_BG)]
    t.setStyle(TableStyle(style))
    return t


def _kv(pairs, width) -> Table:
    return _table([[_p(k, MUTE), _p(v)] for k, v in pairs], [42 * mm, width - 42 * mm], header=False)


def build_pdf(d: dict) -> bytes:
    insp, base, summ = d.get("inspection", {}), d.get("baseline", {}), d.get("summary", {})
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=15 * mm, bottomMargin=16 * mm,
                            title=f"Argus dossier {insp.get('id', '')}", author="Argus ReportAgent")
    W = A4[0] - 30 * mm
    story = []

    outcome = insp.get("outcome") or "INCONCLUSIVE"
    banner = Table([[Paragraph(f'<font color="white" size="8">Overall conclusion</font><br/><font color="white" size="16"><b>{escape(outcome)}</b></font>', BODY)]],
                   colWidths=[52 * mm])
    banner.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(OUTCOME_BG.get(outcome, "#2E3A73"))),
                                ("LEFTPADDING", (0, 0), (-1, -1), 8), ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 8)]))
    title = [Paragraph("Argus inspection dossier", MUTE), Paragraph(escape(insp.get("name", "")), H1),
             Paragraph(escape(f"{'Partial dossier (terminated)' if insp.get('partial') else 'Full dossier'} · {insp.get('lifecycleStatus', '')} · {insp.get('id', '')}"), SMALL)]
    head = Table([[title, banner]], colWidths=[W - 56 * mm, 56 * mm])
    head.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, 0), 1.2, INK), ("BOTTOMPADDING", (0, 0), (-1, -1), 8)]))
    story += [head, Spacer(1, 6)]
    if insp.get("partial"):
        story += [Paragraph("<b>Partial dossier.</b> This inspection was terminated early: evidence and checks are incomplete and it cannot be read as a pass.", BODY), Spacer(1, 4)]

    story += [Paragraph("Inspection", H2), _kv([
        ("Inspection ID", insp.get("id")), ("Started", insp.get("createdAt")), ("Closed", insp.get("closedAt")),
        ("Closure", "Terminate Now (partial)" if insp.get("partial") else "End Inspection (full)"),
        ("Generated", d.get("generatedAt"))], W)]

    casc = base.get("cascade") or {}
    order = base.get("order")
    story += [Paragraph("Reference baseline", H2), _kv([
        ("CAD model", f"{base.get('cadName', '')} ({base.get('modelId', '')}) · rev {base.get('cadRevision', '')}"),
        ("CAD sha256", base.get("cadSha256")),
        ("Equipment", f"{base.get('family', '')} / {str(base.get('type', '')).replace('_', ' ')} / {base.get('endConnection', '')} ends"),
        ("Rule snapshot", f"{base.get('snapshotId', '')} · library revision {base.get('libraryRevision', '')}"),
        ("Snapshot sha256", base.get("snapshotSha256")),
        ("Rule selection", f"library {casc.get('library', '?')} → valve type {casc.get('valveType', '?')} → selected {casc.get('customerSpec', '?')}"
                           + (f" (incl. {casc.get('orderRules')} order rules)" if order else "")),
        ("Customer order", f"{order.get('orderNumber') or ''} · {order.get('name', '')} · sha256 {order.get('sha256', '')}" if order else "None uploaded"),
    ], W)]

    counts = [("Applicable rules", summ.get("applicable", 0), INK), ("Pass", summ.get("pass", 0), colors.HexColor("#0B6B4B")),
              ("Warning", summ.get("warning", 0), colors.HexColor("#7A4900")), ("Fail", summ.get("fail", 0), colors.HexColor("#8E2318")),
              ("Insufficient evidence", summ.get("insufficient", 0), colors.HexColor("#1F5C8A")), ("Not inspected", summ.get("notInspected", 0), MUTED)]
    tiles = Table([[Paragraph(f'<font size="15" color="{c.hexval().replace("0x", "#")}"><b>{n}</b></font><br/><font size="7">{escape(k)}</font>', BODY) for k, n, c in counts]],
                  colWidths=[W / len(counts)] * len(counts))
    tiles.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.4, LINE), ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
    story += [Paragraph("Summary", H2), tiles]

    geo = d.get("geometry")
    if geo:
        cov = geo.get("coverage")
        story += [Paragraph("Laser scan vs CAD", H2), _kv([
            ("Registration", f"{geo.get('status', '')} · ICP fitness {geo.get('fitness', 'n/a')} · {geo.get('chunks', 0)} chunks merged"),
            ("CAD surface coverage", f"{cov * 100:.1f} %" if isinstance(cov, (int, float)) else "n/a"),
            ("Deviation", f"RMS {geo.get('rmsDeviationMm', 'n/a')} mm · 95th percentile {geo.get('p95DeviationMm', 'n/a')} mm · mean {geo.get('meanDeviationMm', 'n/a')} mm"),
        ], W)]

    rows = [[_p("Rule", MUTE), _p("Title", MUTE), _p("Status", MUTE), _p("Requirement and pinned citation", MUTE), _p("Observation and evidence", MUTE)]]
    for f in sorted(d.get("findings", []), key=lambda f: (STATUS_ORDER.get(f.get("status"), 5), str(f.get("ruleId")))):
        req = Paragraph(f'{escape(f.get("quote") or "")}<br/><font color="#4D5365" size="6.5">{escape(f.get("citation") or "")}</font>', CELL)
        obs = Paragraph(f'{escape(f.get("reason") or "Not evaluated.")}'
                        + (f'<br/><font color="#4D5365" size="6.5">{escape(", ".join(f.get("evidence") or []))}</font>' if f.get("evidence") else ""), CELL)
        rows.append([_p(f.get("ruleId")), _p(f.get("title")), _status(f.get("status")), req, obs])
    story += [Paragraph("Findings", H2), _table(rows, [16 * mm, 32 * mm, 20 * mm, (W - 68 * mm) * 0.48, (W - 68 * mm) * 0.52])]

    if d.get("incomplete"):
        story += [Paragraph("Incomplete analysis", H2),
                  _table([[_p("Kind", MUTE), _p("Evidence", MUTE), _p("Reason", MUTE)]] +
                         [[_p(i.get("kind")), _p(i.get("evidenceId") or ""), _p(i.get("reason"))] for i in d["incomplete"]],
                         [24 * mm, 50 * mm, W - 74 * mm])]

    ne = d.get("notEvaluated") or []
    if ne:
        story += [Paragraph(f"Not evaluated from session evidence ({len(ne)})", H2),
                  Paragraph("These rules need measurement, functional-test or work-order records rather than photographs, video or scans.", MUTE), Spacer(1, 3),
                  _table([[_p("Rule", MUTE), _p("Title", MUTE), _p("Source", MUTE)]] +
                         [[_p(r.get("ruleId")), _p(r.get("title")), _p(r.get("citation"))] for r in ne],
                         [34 * mm, (W - 34 * mm) * 0.5, (W - 34 * mm) * 0.5])]

    ev = d.get("evidence") or []
    story += [Paragraph(f"Evidence register ({len(ev)} files)", H2),
              _table([[_p("Type", MUTE), _p("File", MUTE), _p("Source", MUTE), _p("Bytes", MUTE), _p("sha256", MUTE), _p("Analysis", MUTE)]] +
                     [[_p(e.get("mediaType")), _p(e.get("filename")), _p(e.get("sourceId")), _p(e.get("size")),
                       _p((e.get("sha256") or "")[:16] + "…"), _p(e.get("processingStatus"))] for e in ev],
                     [18 * mm, 42 * mm, 30 * mm, 18 * mm, 34 * mm, W - 142 * mm])]

    story += [Spacer(1, 8), KeepTogether([Paragraph("Human review required", H2), Paragraph(escape(d.get("disclaimer") or ""), BODY)])]

    def footer(canvas, _doc):
        canvas.saveState()
        canvas.setFont("Helvetica", 7)
        canvas.setFillColor(MUTED)
        canvas.drawString(15 * mm, 9 * mm, f"Argus · {insp.get('id', '')} · {insp.get('name', '')}"[:110])
        canvas.drawRightString(A4[0] - 15 * mm, 9 * mm, f"Page {_doc.page}")
        canvas.restoreState()

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return buf.getvalue()

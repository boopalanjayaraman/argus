"""Customer specification / work-order documents.

Text extraction (PDF via pypdf in layout mode, DOCX/XLSX via their XML
parts) and deterministic extraction of explicitly numbered order rules
(e.g. ``WO-R01``) from a rule table. Nothing is inferred from narrative
text: a rule exists only where the document prints a rule ID, and its
quote is the document's own wording for that row.
"""
from __future__ import annotations
import collections
import re
import zipfile
from xml.etree import ElementTree

RULE_ID = re.compile(r"\b([A-Z]{2,}-R\d{2,})\b")
ORDER_NO = re.compile(r"\b(WO-[A-Z0-9][A-Z0-9-]*[A-Z0-9])\b")
SEVERITY = re.compile(r"^(FAIL|WARNING|NOT EVALUATED|HOLD|INFO)\b")


def extract_pages(path: str) -> list[str]:
    """Plain text per page (PDF) or per part (DOCX one page, XLSX one per sheet)."""
    lower = path.lower()
    if lower.endswith(".pdf"):
        import pypdf
        reader = pypdf.PdfReader(path)
        return [page.extract_text(extraction_mode="layout") or "" for page in reader.pages]
    if lower.endswith(".docx"):
        return [_docx_text(path)]
    if lower.endswith(".xlsx"):
        return _xlsx_sheets(path)
    raise ValueError(f"unsupported document type: {path}")


def _docx_text(path: str) -> str:
    ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    with zipfile.ZipFile(path) as z:
        root = ElementTree.fromstring(z.read("word/document.xml"))
    lines = []
    for para in root.iter(f"{ns}p"):
        lines.append("".join(t.text or "" for t in para.iter(f"{ns}t")))
    for row in root.iter(f"{ns}tr"):  # table rows as tab-separated cells
        cells = ["".join(t.text or "" for t in cell.iter(f"{ns}t")) for cell in row.iter(f"{ns}tc")]
        lines.append("\t".join(cells))
    return "\n".join(lines)


def _xlsx_sheets(path: str) -> list[str]:
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in ElementTree.fromstring(z.read("xl/sharedStrings.xml")).iter(f"{ns}si"):
                shared.append("".join(t.text or "" for t in si.iter(f"{ns}t")))
        sheets = sorted(n for n in z.namelist() if n.startswith("xl/worksheets/sheet") and n.endswith(".xml"))
        out = []
        for name in sheets:
            rows = []
            for row in ElementTree.fromstring(z.read(name)).iter(f"{ns}row"):
                cells = []
                for c in row.iter(f"{ns}c"):
                    v = c.find(f"{ns}v")
                    text = "".join(t.text or "" for t in c.iter(f"{ns}t")) if c.get("t") == "inlineStr" else (v.text if v is not None else "")
                    if c.get("t") == "s" and text:
                        text = shared[int(text)]
                    cells.append(text or "")
                rows.append("\t".join(cells))
            out.append("\n".join(rows))
        return out


def _strip_repeated(pages: list[str]) -> list[list[str]]:
    """Drop page headers/footers: non-empty lines that repeat on 2+ pages."""
    seen = collections.Counter()
    for page in pages:
        for line in {ln.strip() for ln in page.splitlines() if ln.strip()}:
            seen[line] += 1
    repeated = {line for line, n in seen.items() if n > 1} if len(pages) > 1 else set()
    return [[ln for ln in page.splitlines() if ln.strip() not in repeated] for page in pages]


def _chunks(line: str) -> list[tuple[int, str]]:
    """Text runs separated by 2+ spaces or tabs, with their start column."""
    if "\t" in line:
        out, col = [], 0
        for cell in line.split("\t"):
            if cell.strip():
                out.append((col, cell.strip()))
            col += 1000  # tab cells map to successive columns
        return out
    return [(m.start(), m.group(0).strip()) for m in re.finditer(r"\S(?:\S| (?! ))*", line)]


def _join(parts: list[str]) -> str:
    text = ""
    for part in parts:
        if not text:
            text = part
        elif text.endswith("-"):
            text += part  # hyphenated line break: "air-" + "cushion"
        else:
            text += " " + part
    return re.sub(r"\s+", " ", text).strip()


def _modalities(evidence: str) -> list[str]:
    e = evidence.lower()
    mods = []
    if any(w in e for w in ("image", "photo", "camera", "video", "ocr")):
        mods += ["photo", "video"]
    if "scan" in e or "point" in e:
        mods.append("pointcloud")
    return mods


def parse_order_rules(pages: list[str], source_name: str = "") -> list[dict]:
    """Rules printed in a table whose header has RULE ... ID / criterion /
    EVIDENCE / SEVERITY columns. Rows are matched by rule ID; criterion
    lines between two IDs split at the sentence that ends the earlier row."""
    lines: list[tuple[int, str]] = []  # (page_no, line)
    for page_no, page_lines in enumerate(_strip_repeated(pages), start=1):
        lines += [(page_no, ln) for ln in page_lines]

    header_idx = next((i for i, (_, ln) in enumerate(lines)
                       if "RULE" in ln and "EVIDENCE" in ln and ("CHECK" in ln or "CRITERION" in ln or "REQUIREMENT" in ln)), None)
    if header_idx is None:
        return _parse_inline_rules(lines, source_name)
    header = lines[header_idx][1]
    cols = {"id": header.find("RULE"), "criterion": max(header.find("CHECK"), header.find("CRITERION"), header.find("REQUIREMENT")),
            "evidence": header.find("EVIDENCE"), "severity": header.find("SEVERITY")}
    cols = {k: v for k, v in cols.items() if v >= 0}

    def column(start: int) -> str:
        return min(cols, key=lambda k: abs(cols[k] - start))

    rows: list[dict] = []  # one per printed line inside the table
    for page_no, ln in lines[header_idx + 1:]:
        if ln and not ln[0].isspace() and ln.strip():
            break  # next section heading at column 0 ends the table
        cells: dict[str, list[str]] = collections.defaultdict(list)
        for start, text in _chunks(ln):
            cells[column(start)].append(text)
        if cells:
            rows.append({"page": page_no, **{k: " ".join(v) for k, v in cells.items()}})

    id_rows = [i for i, r in enumerate(rows) if RULE_ID.fullmatch(r.get("id", "").strip())]
    rules = []
    for n, i in enumerate(id_rows):
        prev_i = id_rows[n - 1] if n else -1
        next_i = id_rows[n + 1] if n + 1 < len(id_rows) else len(rows)
        start = _split_point(rows, prev_i, i) if n else 0
        end = _split_point(rows, i, next_i) if next_i < len(rows) else len(rows)
        block = rows[start:end]
        criterion = _join([r["criterion"] for r in block if r.get("criterion") and r["criterion"].upper() != "CRITERION"])
        evidence = _join([r["evidence"] for r in block if r.get("evidence")])
        severity = _join([r["severity"] for r in block if r.get("severity")])
        rule_id = rows[i]["id"].strip()
        mods = _modalities(evidence)
        sev = SEVERITY.match(severity.upper())
        rules.append({
            "ruleId": rule_id, "section": rule_id, "code": rule_id,
            "title": _title(criterion), "quote": criterion,
            "evidenceText": evidence, "severityText": severity,
            "maxSeverity": "WARNING" if sev and sev.group(1) == "WARNING" else ("FAIL" if sev and sev.group(1) == "FAIL" else None),
            "modalities": mods, "features": [],
            "applicability": "APPROVED" if mods else "REFERENCE_ONLY",
            "page": rows[i]["page"], "source": source_name, "origin": "order",
        })
    return rules


def _split_point(rows: list[dict], a: int, b: int) -> int:
    """First row index belonging to the rule whose ID row is b, given the
    previous ID row a: after the last criterion line that ends a sentence
    and is followed by a capitalised line."""
    split = a + 1
    for k in range(a + 1, b):
        text = rows[k].get("criterion", "")
        nxt = rows[k + 1].get("criterion", "") if k + 1 <= b else ""
        if text.endswith(".") and nxt[:1].isupper():
            split = k + 1
    return split


def _parse_inline_rules(lines: list[tuple[int, str]], source_name: str) -> list[dict]:
    """Fallback for documents without a rule table: `WO-R01: text` lines."""
    rules = []
    for page_no, ln in lines:
        m = re.match(r"^\s*([A-Z]{2,}-R\d{2,})[:\s]+(.{10,})$", ln)
        if m:
            quote = re.sub(r"\s+", " ", m.group(2)).strip()
            rules.append({"ruleId": m.group(1), "section": m.group(1), "code": m.group(1), "title": _title(quote),
                          "quote": quote, "evidenceText": "", "severityText": "", "maxSeverity": None,
                          "modalities": ["photo", "video"], "features": [], "applicability": "APPROVED",
                          "page": page_no, "source": source_name, "origin": "order"})
    return rules


def _title(text: str) -> str:
    first = re.split(r"(?<=[.;])\s", text, maxsplit=1)[0].rstrip(".;")
    return first if len(first) <= 90 else first[:87].rstrip() + "..."


def describe(path: str, name: str = "") -> dict:
    """Everything Argus keeps from an uploaded order document."""
    pages = extract_pages(path)
    text = "\n".join(pages)
    order = ORDER_NO.search(text)
    rules = parse_order_rules(pages, name or path.rsplit("/", 1)[-1])
    plain = re.sub(r"[ \t]+", " ", text)
    return {
        "pages": len(pages),
        "orderNumber": order.group(1) if order else None,
        "rules": rules,
        "context": plain[:4000],  # order terms the media models may compare against
        "characters": len(text),
    }

from typing import List, Dict

def csv_escape(v: str) -> str:
    s = (v or "")
    if any(ch in s for ch in [",", '"', "\n"]):
        s = '"' + s.replace('"', '""') + '"'
    return s

def rows_to_csv(rows: List[Dict]) -> str:
    header = "name,phone_e164,wa_status,address,source\n"
    body = "\n".join(
        ",".join([
            csv_escape(r.get("name","")),
            csv_escape(r.get("phone_e164","")),
            csv_escape(r.get("wa_status","unknown")),
            csv_escape(r.get("address","")),
            csv_escape(r.get("source","")),
        ]) for r in rows
    )
    return header + body + ("\n" if body else "")

import re
import phonenumbers as pn

def to_e164_br(raw: str) -> str | None:
    s = re.sub(r"[^\d+]", "", (raw or ""))
    candidates = []
    if s:
        candidates.append(s)
        if not s.startswith("+"):
            candidates.append("+55" + s)
    for cand in candidates:
        try:
            n = pn.parse(cand, "BR")
            if pn.is_possible_number(n) and pn.is_valid_number(n):
                return pn.format_number(n, pn.PhoneNumberFormat.E164)
        except Exception:
            pass
    return None

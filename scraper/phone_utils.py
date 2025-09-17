import re
import phonenumbers as pn

def to_e164_br(raw: str) -> str | None:
    """
    Converte telefone brasileiro para formato E.164 (+55...).
    """
    if not raw:
        return None

    s = re.sub(r"[^\d+]", "", raw)

    for candidate in (s, "+55" + s if not s.startswith("+") else None):
        if not candidate:
            continue
        try:
            n = pn.parse(candidate, "BR")
            if pn.is_possible_number(n) and pn.is_valid_number(n):
                return pn.format_number(n, pn.PhoneNumberFormat.E164)
        except Exception:
            pass

    return None

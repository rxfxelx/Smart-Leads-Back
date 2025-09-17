import re
from bs4 import BeautifulSoup
from .phone_utils import to_e164_br

PHONE_REGEX = re.compile(r"(\+?55\s*)?(\(?\d{2}\)?\s*)?(?:9?\d{4})[-.\s]?\d{4}")

def get_title(html: str) -> str:
    try:
        soup = BeautifulSoup(html, "lxml")
        return (soup.title.string or "").strip()[:200]
    except Exception:
        return ""

def extract_phones_from_html(html: str) -> list[str]:
    if not html:
        return []

    found: set[str] = set()

    # tel:
    for m in re.finditer(r'href=["\']tel:([^"\']+)["\']', html, flags=re.I):
        e164 = to_e164_br(m.group(1))
        if e164:
            found.add(e164)

    # wa.me
    for m in re.finditer(r'wa\.me/(\d{10,15})', html, flags=re.I):
        raw = m.group(1)
        e164 = to_e164_br("+" + raw if raw.startswith("55") else "+55" + raw)
        if e164:
            found.add(e164)

    # api.whatsapp.com
    for m in re.finditer(r'api\.whatsapp\.com/[^"\']*?[?&]phone=(\d{10,15})', html, flags=re.I):
        raw = m.group(1)
        e164 = to_e164_br("+" + raw if raw.startswith("55") else "+55" + raw)
        if e164:
            found.add(e164)

    # texto
    for m in PHONE_REGEX.finditer(html):
        e164 = to_e164_br(m.group(0))
        if e164:
            found.add(e164)

    return sorted(found)

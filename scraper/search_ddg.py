import urllib.parse
from bs4 import BeautifulSoup

def decode_duck_link(href: str) -> str:
    try:
        if href.startswith("/l/"):
            href = "https://duckduckgo.com" + href
        u = urllib.parse.urlparse(href)
        if "duckduckgo.com" in u.netloc:
            qs = urllib.parse.parse_qs(u.query)
            if "uddg" in qs:
                return urllib.parse.unquote(qs["uddg"][0])
    except Exception:
        pass
    return href

def ddg_extract_links(html: str, limit: int = 40) -> list[str]:
    soup = BeautifulSoup(html, "lxml")
    hrefs: list[str] = []

    for a in soup.select('a.result__a, a[href^="/l/"]'):
        real = decode_duck_link(a.get("href") or "")
        try:
            host = urllib.parse.urlparse(real).netloc
            if host and "duckduckgo.com" not in host:
                hrefs.append(real)
        except Exception:
            pass

    out, seen = [], set()
    for u in hrefs:
        if u not in seen:
            seen.add(u)
            out.append(u)
        if len(out) >= limit:
            break
    return out

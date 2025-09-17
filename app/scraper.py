from __future__ import annotations
import re
from typing import List, Dict
from urllib.parse import urlparse, parse_qs, unquote, quote_plus
from playwright.async_api import async_playwright
from app.phone_utils import to_e164_br

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

PHONE_RE = re.compile(r"(\+?55\s*)?(\(?\d{2}\)?\s*)?(?:9?\d{4})[-.\s]?\d{4}")

def decode_ddg(href: str) -> str:
    """Decodifica redirecionamentos do DuckDuckGo (/l/?uddg=... e /r?uddg=...)."""
    try:
        if href.startswith("/l/") or href.startswith("/r?"):
            href = "https://duckduckgo.com" + href
        u = urlparse(href)
        if "duckduckgo.com" in u.netloc:
            qs = parse_qs(u.query)
            if "uddg" in qs and qs["uddg"]:
                return unquote(qs["uddg"][0])
    except Exception:
        pass
    return href

def extract_phones_from_html(html: str) -> List[str]:
    out = set()
    # href tel:
    for m in re.finditer(r'href=["\']tel:([^"\']+)["\']', html, flags=re.I):
        e = to_e164_br(m.group(1));  out.add(e) if e else None
    # wa.me
    for m in re.finditer(r'wa\.me/(\d{10,15})', html, flags=re.I):
        raw = m.group(1); cand = ("+" if raw.startswith("55") else "+55") + raw
        e = to_e164_br(cand);  out.add(e) if e else None
    # api.whatsapp.com
    for m in re.finditer(r'api\.whatsapp\.com/[^"\']*?[?&]phone=(\d{10,15})', html, flags=re.I):
        raw = m.group(1); cand = ("+" if raw.startswith("55") else "+55") + raw
        e = to_e164_br(cand);  out.add(e) if e else None
    # texto solto
    for m in PHONE_RE.finditer(html):
        e = to_e164_br(m.group(0)); out.add(e) if e else None
    return sorted(out)

async def collect_ddg_links(page, query: str, max_links: int) -> List[str]:
    url = f"https://duckduckgo.com/html/?q={quote_plus(query)}&kl=br-pt&ia=web"
    await page.goto(url, wait_until="domcontentloaded", timeout=45000)
    hrefs = await page.evaluate(
        "() => Array.from(document.querySelectorAll('a[href]')).map(a => a.getAttribute('href'))"
    )
    links = []
    for h in hrefs:
        if not h: continue
        real = decode_ddg(h)
        try:
            host = urlparse(real).netloc
            if host and "duckduckgo.com" not in host and real not in links:
                links.append(real)
        except Exception:
            pass
        if len(links) >= max_links:
            break
    return links

async def search_and_collect(city: str, segment: str, total: int, headless: bool=True) -> List[Dict]:
    query_base = f"{segment or 'empresas'} {city}"
    queries = [f"{query_base} telefone", f"{query_base} contato", f"{query_base} whatsapp"]
    rows, seen = [], set()
    max_links = max(20, min(total * 5, 80))

    from playwright.async_api import async_playwright
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=headless,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
            ],
        )
        context = await browser.new_context(user_agent=UA, locale="pt-BR")
        page = await context.new_page()

        all_links: List[str] = []
        for q in queries:
            try:
                ls = await collect_ddg_links(page, q, max_links)
                for u in ls:
                    if u not in all_links:
                        all_links.append(u)
                if len(all_links) >= max_links:
                    break
            except Exception:
                pass

        # Visitar e extrair
        for url in all_links[:max_links]:
            try:
                p = await context.new_page()
                await p.goto(url, wait_until="domcontentloaded", timeout=45000)
                html = await p.content()
                phones = extract_phones_from_html(html)
                title = (await p.title()) or url
                await p.close()
                for e in phones:
                    if e in seen: continue
                    seen.add(e)
                    rows.append({
                        "name": title[:160],
                        "phone_e164": e,
                        "wa_status": "unvalidated",
                        "address": "",
                        "source": url
                    })
                    if len(rows) >= total: break
            except Exception:
                pass
            if len(rows) >= total: break

        await context.close()
        await browser.close()

    return rows

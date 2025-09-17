#!/usr/bin/env python3
from __future__ import annotations
import asyncio, argparse, json, re
from urllib.parse import urlparse, parse_qs, unquote, quote_plus
from playwright.async_api import async_playwright
import phonenumbers as pn

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

PHONE_RE = re.compile(r"(\+?55\s*)?(\(?\d{2}\)?\s*)?(?:9?\d{4})[-.\s]?\d{4}")

def to_e164_br(raw: str) -> str | None:
    s = re.sub(r"[^\d+]", "", raw or "")
    for cand in (s, "+55"+s if not s.startswith("+") else None):
        if not cand:
            continue
        try:
            n = pn.parse(cand, "BR")
            if pn.is_possible_number(n) and pn.is_valid_number(n):
                return pn.format_number(n, pn.PhoneNumberFormat.E164)
        except Exception:
            pass
    return None

def decode_ddg(href: str) -> str:
    """
    Decodifica links do DuckDuckGo:
      - /l/?uddg=<url>
      - /r?uddg=<url>
      - https://duckduckgo.com/l/?uddg=...
      - https://duckduckgo.com/r?uddg=...
    """
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

async def extract_phones_from_html(html: str) -> list[str]:
    out = set()
    for m in re.finditer(r'href=["\']tel:([^"\']+)["\']', html, flags=re.I):
        e = to_e164_br(m.group(1));  out.add(e) if e else None
    for m in re.finditer(r'wa\.me/(\d{10,15})', html, flags=re.I):
        raw = m.group(1); e = to_e164_br(("+" if raw.startswith("55") else "+55") + raw); out.add(e) if e else None
    for m in re.finditer(r'api\.whatsapp\.com/[^"\']*?[?&]phone=(\d{10,15})', html, flags=re.I):
        raw = m.group(1); e = to_e164_br(("+" if raw.startswith("55") else "+55") + raw); out.add(e) if e else None
    for m in PHONE_RE.finditer(html):
        e = to_e164_br(m.group(0)); out.add(e) if e else None
    return sorted(out)

def csv_escape(val: str) -> str:
    s = (val or "")
    if any(ch in s for ch in [',', '"', '\n']):
        s = '"' + s.replace('"', '""') + '"'
    return s

async def collect_ddg_links(page, query: str, max_links: int) -> list[str]:
    # Usamos a versão HTML “lite” (estável para scraping)
    url = f"https://duckduckgo.com/html/?q={quote_plus(query)}&kl=br-pt&ia=web"
    await page.goto(url, wait_until="domcontentloaded", timeout=45000)
    # Coleta todos os <a href> e decodifica os que são de redirecionamento
    hrefs = await page.evaluate(
        "() => Array.from(document.querySelectorAll('a[href]'))"
        ".map(a => a.getAttribute('href'))"
    )
    links = []
    for h in hrefs:
        if not h: 
            continue
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

async def search_and_collect(city: str, segment: str, total: int, headless: bool = True) -> dict:
    query_base = f"{segment or 'empresas'} {city}"
    # reforça sinais que costumam aparecer junto de telefone
    queries = [
        f"{query_base} telefone",
        f"{query_base} contato",
        f"{query_base} whatsapp"
    ]

    rows, seen = [], set()
    max_links = max(20, min(total * 5, 80))

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

        # 1) Junta os links das consultas
        all_links: list[str] = []
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

        # 2) Visita os sites e extrai telefones
        for url in all_links[:max_links]:
            try:
                p = await context.new_page()
                await p.goto(url, wait_until="domcontentloaded", timeout=45000)
                html = await p.content()
                phones = await extract_phones_from_html(html)
                title = (await p.title()) or url
                await p.close()

                for e in phones:
                    if e in seen:
                        continue
                    seen.add(e)
                    rows.append({
                        "name": title[:160],
                        "phone_e164": e,
                        "wa_status": "unvalidated",
                        "address": "",
                        "source": url
                    })
                    if len(rows) >= total:
                        break
            except Exception:
                pass
            if len(rows) >= total:
                break

        await context.close()
        await browser.close()

    header = "name,phone_e164,wa_status,address,source\n"
    lines = [
        f"{csv_escape(r['name'])},{r['phone_e164']},unvalidated,,{csv_escape(r['source'])}"
        for r in rows
    ]
    csv = header + "\n".join(lines) + ("\n" if lines else "")
    return {"ok": True, "query": query_base, "total": len(rows), "rows": rows, "csv": csv}

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--city", required=True)
    ap.add_argument("--segment", default="")
    ap.add_argument("--total", type=int, default=50)
    ap.add_argument("--headful", action="store_true", help="Abrir janela (para testes locais)")
    args = ap.parse_args()
    data = await search_and_collect(
        args.city, args.segment, max(1, min(args.total, 200)), headless=not args.headful
    )
    print(json.dumps(data, ensure_ascii=False))

if __name__ == "__main__":
    asyncio.run(main())

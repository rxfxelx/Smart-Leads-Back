#!/usr/bin/env python3
from __future__ import annotations
import asyncio, argparse, json, re
from urllib.parse import urlparse, parse_qs, unquote
from bs4 import BeautifulSoup
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
    try:
        u = urlparse(href)
        if "duckduckgo.com" in u.netloc:
            qs = parse_qs(u.query)
            if "uddg" in qs:
                return unquote(qs["uddg"][0])
    except Exception:
        pass
    return href

async def extract_phones_from_html(html: str) -> list[str]:
    out = set()
    # tel:
    for m in re.finditer(r'href=["\']tel:([^"\']+)["\']', html, flags=re.I):
        e = to_e164_br(m.group(1))
        if e: out.add(e)
    # wa.me e api.whatsapp.com
    for m in re.finditer(r'wa\.me/(\d{10,15})', html, flags=re.I):
        raw = m.group(1); e = to_e164_br("+"+raw if raw.startswith("55") else "+55"+raw)
        if e: out.add(e)
    for m in re.finditer(r'api\.whatsapp\.com/[^"\']*?[?&]phone=(\d{10,15})', html, flags=re.I):
        raw = m.group(1); e = to_e164_br("+"+raw if raw.startswith("55") else "+55"+raw)
        if e: out.add(e)
    # texto
    for m in PHONE_RE.finditer(html):
        e = to_e164_br(m.group(0))
        if e: out.add(e)
    return sorted(out)

async def search_and_collect(city: str, segment: str, total: int, headless: bool = True) -> dict:
    query_base = f"{segment or 'empresas'} {city}"
    queries = [f"{query_base} telefone", f"{query_base} contato"]

    rows, seen = [], set()
    max_links = max(20, min(total * 5, 80))

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=headless, args=["--no-sandbox","--disable-gpu"])
        context = await browser.new_context(user_agent=UA, locale="pt-BR")
        page = await context.new_page()

        # Preferir DuckDuckGo (menos bloqueio); se desejar troque por Google
        links = []
        for q in queries:
            await page.goto("https://duckduckgo.com/?ia=web&kl=br-pt", wait_until="domcontentloaded")
            await page.fill("input[name=q]", q)
            await page.keyboard.press("Enter")
            await page.wait_for_load_state("domcontentloaded")
            # Pegar resultados (link real ou /l/?uddg=)
            anchors = await page.locator("a.result__a, a[href^='/l/']").evaluate_all("els => els.map(e => e.href)")
            for h in anchors:
                real = decode_ddg(h)
                try:
                    host = urlparse(real).netloc
                    if host and "duckduckgo.com" not in host and real not in links:
                        links.append(real)
                except Exception: pass
            if len(links) >= max_links: break

        # Visitar os sites e extrair telefones
        for url in links[:max_links]:
            try:
                p = await context.new_page()
                await p.goto(url, wait_until="domcontentloaded", timeout=45000)
                html = await p.content()
                phones = await extract_phones_from_html(html)
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

    header = "name,phone_e164,wa_status,address,source\n"
    body = "\n".join(f'{r["name"].replace(","," ").replace("\n"," ")},{r["phone_e164"]},unvalidated,,{r["source"]}' for r in rows)
    csv = header + body + ("\n" if body else "")
    return {"ok": True, "query": query_base, "total": len(rows), "rows": rows, "csv": csv}

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--city", required=True)
    ap.add_argument("--segment", default="")
    ap.add_argument("--total", type=int, default=50)
    ap.add_argument("--headful", action="store_true", help="Abrir janela (para testes locais)")
    args = ap.parse_args()
    data = await search_and_collect(args.city, args.segment, max(1, min(args.total, 200)), headless=not args.headful)
    print(json.dumps(data, ensure_ascii=False))

if __name__ == "__main__":
    asyncio.run(main())

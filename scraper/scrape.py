#!/usr/bin/env python3
import asyncio, aiohttp, argparse, json, urllib.parse
from .search_ddg import ddg_extract_links
from .html_extract import extract_phones_from_html, get_title

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

async def fetch_text(session, url: str):
    try:
        async with session.get(url, timeout=30) as resp:
            if resp.status >= 400:
                return None
            return await resp.text()
    except Exception:
        return None

async def ddg_search(session, query: str, limit: int = 40):
    url = "https://duckduckgo.com/html/?q=" + urllib.parse.quote(query) + "&kl=br-pt&ia=web"
    html = await fetch_text(session, url)
    if not html:
        return []
    return ddg_extract_links(html, limit=limit)

async def crawl_and_extract(urls, total):
    rows, seen = [], set()
    headers = {"User-Agent": UA}
    sem = asyncio.Semaphore(10)
    async with aiohttp.ClientSession(headers=headers) as session:
        async def one(url):
            async with sem:
                html = await fetch_text(session, url)
                if not html:
                    return
                phones = extract_phones_from_html(html)
                if not phones:
                    return
                title = get_title(html) or url
                for e164 in phones:
                    if e164 in seen:
                        continue
                    seen.add(e164)
                    rows.append({
                        "name": title,
                        "phone_e164": e164,
                        "wa_status": "unvalidated",
                        "address": "",
                        "source": url
                    })
        tasks = [asyncio.create_task(one(u)) for u in urls]
        await asyncio.gather(*tasks)
    return rows[:total]

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--city", required=True)
    ap.add_argument("--segment", default="")
    ap.add_argument("--total", type=int, default=50)
    args = ap.parse_args()

    query = f"{args.segment or 'empresas'} {args.city}"
    async with aiohttp.ClientSession(headers={"User-Agent": UA}) as session:
        links = []
        for q in [f"{query} telefone", f"{query} contato"]:
            links.extend(await ddg_search(session, q, limit=min(args.total*5, 60)))
        urls = list(dict.fromkeys(links))  # dedup

    rows = await crawl_and_extract(urls, args.total)

    header = "name,phone_e164,wa_status,address,source\n"
    lines = [
        f'{r["name"].replace(","," ").replace("\n"," ")},{r["phone_e164"]},unvalidated,,{r["source"]}'
        for r in rows
    ]
    csv = header + "\n".join(lines) + "\n"

    print(json.dumps({"ok": True, "query": query, "total": len(rows), "rows": rows, "csv": csv}, ensure_ascii=False))

if __name__ == "__main__":
    asyncio.run(main())

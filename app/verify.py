from __future__ import annotations
import os, asyncio
from typing import List, Dict
import httpx

CLICK2CHAT_URL = "https://api.whatsapp.com/send?phone={phone}"

async def verify_click2chat(numbers_e164: List[str], *, concurrency: int = 8) -> Dict[str, str]:
    """Heurística gratuita usando a página 'click to chat'."""
    out: Dict[str, str] = {}
    sem = asyncio.Semaphore(concurrency)

    async def one(e164: str):
        phone = e164.lstrip("+")
        url = CLICK2CHAT_URL.format(phone=phone)
        async with sem:
            try:
                async with httpx.AsyncClient(timeout=20) as client:
                    r = await client.get(url, headers={"User-Agent":"Mozilla/5.0"})
                    html = r.text
                    if r.status_code >= 400:
                        out[e164] = "unknown"; return
                    if ("invalid phone number" in html.lower()
                        or ("número de telefone" in html.lower() and "inválido" in html.lower())):
                        out[e164] = "invalid"
                    elif ("continue to chat" in html.lower()
                          or "continuar para" in html.lower()):
                        out[e164] = "valid"
                    else:
                        out[e164] = "unknown"
            except Exception:
                out[e164] = "unknown"

    await asyncio.gather(*(one(n) for n in numbers_e164))
    return out

async def verify_whapi(numbers_e164: List[str]) -> Dict[str, str]:
    """Exemplo genérico para gateways tipo WHAPI (ajuste conforme seu fornecedor)."""
    base = os.getenv("WHAPI_BASE_URL", "").rstrip("/")
    token = os.getenv("WHAPI_TOKEN", "")
    if not base or not token:
        return {n: "unknown" for n in numbers_e164}

    url = f"{base}/contacts/check"
    headers = {"Authorization": f"Bearer {token}", "Content-Type":"application/json"}
    payload = {"phones": numbers_e164}

    out: Dict[str, str] = {}
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(url, headers=headers, json=payload)
            data = r.json()
            # Exemplo esperado: {"results":[{"phone":"+55...","exists":true}]}
            for item in data.get("results", []):
                e164 = item.get("phone")
                exists = item.get("exists")
                if e164:
                    out[e164] = "valid" if exists else "invalid"
    except Exception:
        out = {n: "unknown" for n in numbers_e164}

    for n in numbers_e164:
        out.setdefault(n, "unknown")
    return out

async def verify_uazapi(numbers_e164: List[str]) -> Dict[str, str]:
    """
    Integração flexível com UAZ API.
    Requer (pelo Postman público da UAZAPI) header de API key chamado 'apikey' e rota que inclui o nome da instância.
    Variáveis de ambiente:
      - UAZ_BASE_URL       (ex.: https://seu-servidor.uazapi.dev)
      - UAZ_INSTANCE       (ex.: minhaInstancia)
      - UAZ_API_KEY        (valor do header 'apikey')
      - UAZ_VERIFY_PATH    (ex.: /contacts/checkwhatsapp  OU  /contacts/check)  -> você ajusta conforme sua documentação
    O código abaixo tenta duas formas comuns:
      1) POST {BASE}{PATH}/{INSTANCE}  com body {"phones":["+55..."]}
      2) POST {BASE}{PATH}             com body {"instance":"...", "phones":[...]}
    E entende respostas nos formatos comuns:
      - {"results":[{"phone":"+55...","exists":true}]}
      - {"data":[{"phone":"+55...","is_whatsapp":true}]}
      - {"success":true, "status":"valid"} (quando consulta 1 por vez)
    """
    base = os.getenv("UAZ_BASE_URL", "").rstrip("/")
    inst = os.getenv("UAZ_INSTANCE", "").strip()
    key  = os.getenv("UAZ_API_KEY", "").strip()
    path = os.getenv("UAZ_VERIFY_PATH", "/contacts/check").strip()
    if not base or not inst or not key:
        return {n: "unknown" for n in numbers_e164}

    headers = {"apikey": key, "Content-Type":"application/json"}
    out: Dict[str, str] = {}

    async def parse_and_fill(e164_list: List[str], resp_json: dict):
        # Tenta vários formatos conhecidos
        if isinstance(resp_json, dict):
            if "results" in resp_json and isinstance(resp_json["results"], list):
                for item in resp_json["results"]:
                    e = item.get("phone"); ex = item.get("exists")
                    if e: out[e] = "valid" if ex else "invalid"
            if "data" in resp_json and isinstance(resp_json["data"], list):
                for item in resp_json["data"]:
                    e = item.get("phone"); ex = item.get("is_whatsapp")
                    if e: out[e] = "valid" if ex else "invalid"
            if "success" in resp_json and len(e164_list) == 1:
                e = e164_list[0]
                st = resp_json.get("status")
                if st in ("valid","invalid","unknown"):
                    out[e] = st

    try:
        async with httpx.AsyncClient(timeout=40) as client:
            # tentativa 1: .../{instance}
            url1 = f"{base}{path.rstrip('/')}/{inst}"
            r1 = await client.post(url1, headers=headers, json={"phones": numbers_e164})
            if r1.status_code < 500:
                try:
                    await parse_and_fill(numbers_e164, r1.json())
                except Exception:
                    pass

            # tentativa 2: sem /{instance}, mas com instance no body
            missing = [n for n in numbers_e164 if n not in out]
            if missing:
                url2 = f"{base}{path}"
                r2 = await client.post(url2, headers=headers, json={"instance": inst, "phones": missing})
                if r2.status_code < 500:
                    try:
                        await parse_and_fill(missing, r2.json())
                    except Exception:
                        pass
    except Exception:
        pass

    # default
    for n in numbers_e164:
        out.setdefault(n, "unknown")
    return out

async def validate_numbers(rows: List[Dict], provider: str = "CLICK2CHAT") -> List[Dict]:
    uniques = sorted({r.get("phone_e164") for r in rows if r.get("phone_e164")})
    if not uniques:
        return rows

    provider = provider.upper()
    if provider == "UAZAPI":
        status_map = await verify_uazapi(uniques)
    elif provider == "WHAPI":
        status_map = await verify_whapi(uniques)
    else:
        status_map = await verify_click2chat(uniques)

    out: List[Dict] = []
    for r in rows:
        e = r.get("phone_e164")
        r2 = dict(r)
        r2["wa_status"] = status_map.get(e, r.get("wa_status") or "unknown")
        out.append(r2)
    return out

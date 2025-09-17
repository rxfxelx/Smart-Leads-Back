import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from app.scraper import search_and_collect
from app.verify import validate_numbers
from app.csv_utils import rows_to_csv

app = FastAPI(title="Smart Leads (Python)")

# CORS
CORS_ANY = os.getenv("CORS_ANY", "0") == "1"
ALLOWED = [s.strip() for s in os.getenv("CORS_ORIGINS", "").split(",") if s.strip()]
if CORS_ANY:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
elif ALLOWED:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# Front estático
static_dir = os.path.join(os.path.dirname(__file__), "static")
app.mount("/static", StaticFiles(directory=static_dir), name="static")

@app.get("/", response_class=HTMLResponse)
async def home():
    return FileResponse(os.path.join(static_dir, "index.html"))

class RunBody(BaseModel):
    city: str = Field(..., min_length=2)
    segment: str = ""
    total: int = Field(50, ge=1, le=200)

@app.get("/api/status")
async def status():
    provider = os.getenv("VALIDATION_PROVIDER", "CLICK2CHAT").upper()
    return {
        "ok": True,
        "validationProvider": provider,
        "searchMode": "Playwright (DuckDuckGo HTML) + raspagem",
        "ts": __import__("time").time(),
    }

@app.post("/api/run")
async def run(body: RunBody):
    """
    Pipeline completo:
      1) Busca links no DDG e raspa telefones nos sites com Playwright
      2) Normaliza p/ E.164 BR
      3) Valida automaticamente via provedor (CLICK2CHAT, UAZAPI, WHAPI)
      4) Retorna rows + CSV
    """
    try:
        rows = await search_and_collect(
            city=body.city.strip(),
            segment=body.segment.strip(),
            total=body.total,
            headless=(os.getenv("PLAYWRIGHT_HEADFUL", "0") != "1")
        )

        provider = os.getenv("VALIDATION_PROVIDER", "CLICK2CHAT").upper()
        rows = await validate_numbers(rows, provider=provider)

        csv = rows_to_csv(rows)
        return JSONResponse({
            "ok": True,
            "query": f"{body.segment or 'empresas'} {body.city}",
            "total": len(rows),
            "rows": rows,
            "csv": csv
        })
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

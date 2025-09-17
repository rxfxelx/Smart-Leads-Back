# Smart Leads (Python) – Busca + Validação WhatsApp (automática)

**Stack:** FastAPI + Playwright (Chromium headless) + httpx + phonenumbers.  
**Fluxo:** Busca links (DuckDuckGo HTML), navega nos sites, raspa telefones, normaliza E.164, **valida automaticamente** no WhatsApp (UAZAPI / WHAPI / Click2Chat) e permite baixar CSV.

## Variáveis de Ambiente
| Nome | Exemplo | Observação |
|---|---|---|
| `CORS_ANY` | `1` | Libera CORS para qualquer origem (teste). |
| `CORS_ORIGINS` | `https://meufront.com` | Use no lugar de `CORS_ANY` em produção. |
| `VALIDATION_PROVIDER` | `UAZAPI` \| `WHAPI` \| `CLICK2CHAT` | Provedor de verificação. |
| `PLAYWRIGHT_HEADFUL` | `0` | Em Railway mantenha `0` (headless). |

### UAZAPI
| Nome | Exemplo |
|---|---|
| `UAZ_BASE_URL` | `https://seu-servidor.uazapi.dev` |
| `UAZ_INSTANCE` | `minhaInstancia` |
| `UAZ_API_KEY` | `seu_api_key` |
| `UAZ_VERIFY_PATH` | `/contacts/check` (ajuste conforme docs) |

> Pelo material público da UAZ (Postman), o **header de autenticação** é `apikey` e as rotas costumam incluir o **nome da instância** na URL; veja o Postman público “uazapi - WhatsApp API (v1.0)”. citeturn1view0

### WHAPI (opcional/exemplo)
| Nome | Exemplo |
|---|---|
| `WHAPI_BASE_URL` | `https://api.whapi.cloud` |
| `WHAPI_TOKEN` | `Bearer xxxxx` |

## Rodar local
```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m playwright install --with-deps chromium
uvicorn app.main:app --reload
```
Abra: http://localhost:8000

## Deploy (Railway)
- Conecte o repositório e use o `Dockerfile` incluso.
- Defina as **Variables** (acima).
- A aplicação sobe em `:8000`.

## Como o verificador UAZ funciona aqui
O arquivo `app/verify.py` tem a função `verify_uazapi` com um **adaptador flexível**:
1. Tenta `POST {UAZ_BASE_URL}{UAZ_VERIFY_PATH}/{UAZ_INSTANCE}` com body `{"phones": ["+55..."]}`.  
2. Se faltar algo, tenta `POST {UAZ_BASE_URL}{UAZ_VERIFY_PATH}` com body `{"instance":"...", "phones":[...]}`.  
3. Entende respostas comuns como:
   - `{"results":[{"phone":"+55...","exists":true}]}`  
   - `{"data":[{"phone":"+55...","is_whatsapp":true}]}`  
   - `{"success":true,"status":"valid"}` (consulta unitária)  

> Ajuste `UAZ_VERIFY_PATH` conforme a rota real da sua instância (o Postman público indica que as requisições usam **apikey** e **instância** na URL). citeturn1view0

## Avisos
- Scraping depende de como os sites expõem telefones; resultados variam por segmento/cidade.
- Mantenha `total` moderado em hospedagens com pouca RAM/CPU.
- O modo **Click2Chat** é heurístico (sem garantias). Para produção, use seu provedor oficial (ex.: UAZAPI).

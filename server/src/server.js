require('dotenv').config()
const express = require('express')
const morgan = require('morgan')
const path = require('path')
const { textSearch, placeDetails } = require('./google')
const { toE164BR, dedupeE164 } = require('./phone')
const { validateNumbers } = require('./whatsapp')

const app = express()
const PORT = process.env.PORT || 5173

app.use(morgan('dev'))
app.use(express.json({ limit: '1mb' }))

// ---------- CORS + Preflight robusto ----------
const ALLOWED = (process.env.CORS_ORIGINS || 'https://smart-leads-front.vercel.app,http://localhost:5173')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && (ALLOWED.includes(origin) || process.env.CORS_ANY === '1')) {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ANY === '1' ? '*' : origin)
    // Se você não usa cookies/autenticação via fetch, pode omitir esta linha:
    // res.setHeader('Access-Control-Allow-Credentials', 'true')
  }
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Max-Age', '86400')

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204) // responde o preflight
  }
  next()
})

// Se você quiser servir o front estático a partir do mesmo app:
app.use(express.static(path.join(__dirname, '../../public')))

app.get('/api/status', (_, res) => {
  res.json({
    ok: true,
    validationProvider: (process.env.VALIDATION_PROVIDER || 'NONE').toUpperCase(),
    hasPlaces: Boolean(process.env.PLACES_API_KEY)
  })
})

/**
 * Valida uma lista enviada pelo cliente (CSV ou manual).
 * Body: { numbers: ["+55...", "3199..."] }
 */
app.post('/api/validate', async (req, res) => {
  try {
    const { numbers } = req.body || {}
    if (!Array.isArray(numbers) || numbers.length === 0) {
      return res.status(400).json({ error: 'Envie um array "numbers".' })
    }
    const rawList = numbers.map(n => (n ?? '').toString().trim()).filter(Boolean)
    const mappings = rawList.map(raw => ({ raw, e164: toE164BR(raw) }))
    const e164Unique = [...new Set(mappings.map(m => m.e164).filter(Boolean))]

    const provider = (process.env.VALIDATION_PROVIDER || 'NONE').toUpperCase()
    const validation = await validateNumbers({
      provider,
      numbers: e164Unique,
      whapi: { token: process.env.WHAPI_TOKEN, baseUrl: process.env.WHAPI_BASE_URL }
    })

    const statusByE164 = new Map(validation.map(v => [v.input, v.status]))
    const waIdByE164   = new Map(validation.map(v => [v.input, v.wa_id || null]))

    const results = mappings.map(({ raw, e164 }) => ({
      raw,
      e164,
      status: e164 ? (statusByE164.get(e164) || 'unknown') : 'invalid',
      wa_id: e164 ? (waIdByE164.get(e164) || null) : null
    }))

    res.json({ ok: true, results })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message || String(err) })
  }
})

/**
 * Pipeline completo:
 *  - Busca empresas (Google Places) por "segmento in cidade"
 *  - Extrai telefones, formata E.164
 *  - Valida via provedor (WHAPI ou NONE)
 *  - Limita ao total solicitado
 */
app.post('/api/run', async (req, res) => {
  try {
    const { city, segment, total } = req.body || {}
    const max = Math.min(Number(total || 50), 1000)
    if (!process.env.PLACES_API_KEY) {
      return res.status(400).json({ error: 'PLACES_API_KEY não configurado no servidor.' })
    }
    if (!city || String(city).trim().length < 2) {
      return res.status(400).json({ error: 'Informe a cidade ou região.' })
    }

    const query = `${segment && segment.trim().length ? segment : 'empresas'} in ${city}`

    // 1) Buscar place_ids
    const placeIds = await textSearch({
      apiKey: process.env.PLACES_API_KEY,
      query,
      region: 'br',
      language: 'pt-BR',
      maxPages: 5
    })

    // 2) Detalhes/telefone
    const details = []
    for (const pid of placeIds) {
      if (details.length >= max * 2) break
      const d = await placeDetails({ apiKey: process.env.PLACES_API_KEY, placeId: pid })
      if (d && d.phone) details.push(d)
      await new Promise(r => setTimeout(r, 150)) // reduzir QPS
    }

    // 3) Extrair/formatar
    const enriched = []
    for (const d of details) {
      const e164 = toE164BR(d.phone)
      if (e164) {
        enriched.push({
          name: d.name || '',
          phone_e164: e164,
          address: d.address || '',
          source: 'Google Places'
        })
      }
    }

    // 4) Deduplicar e cortar
    const uniquePhones = dedupeE164(enriched.map(e => e.phone_e164)).slice(0, max)
    const uniqueMap = new Map(uniquePhones.map(p => [p, true]))
    const compact = enriched.filter(e => uniqueMap.has(e.phone_e164))

    // 5) Validar WhatsApp
    const provider = (process.env.VALIDATION_PROVIDER || 'NONE').toUpperCase()
    const validation = await validateNumbers({
      provider,
      numbers: compact.map(e => e.phone_e164),
      whapi: { token: process.env.WHAPI_TOKEN, baseUrl: process.env.WHAPI_BASE_URL }
    })

    const statusByNumber = new Map(validation.map(v => [v.input, v.status]))
    const waIdByNumber   = new Map(validation.map(v => [v.input, v.wa_id || null]))

    const finalRows = compact.map(e => ({
      name: e.name,
      phone_e164: e.phone_e164,
      wa_status: statusByNumber.get(e.phone_e164) || 'unknown',
      wa_id: waIdByNumber.get(e.phone_e164),
      address: e.address,
      source: e.source
    }))

    // 6) CSV simples
    const csvHeader = 'name,phone_e164,wa_status,address,source\n'
    const csvBody = finalRows.map(r => [
      csvEscape(r.name),
      csvEscape(r.phone_e164),
      csvEscape(r.wa_status),
      csvEscape(r.address),
      csvEscape(r.source)
    ].join(',')).join('\n')
    const csv = csvHeader + csvBody + '\n'

    res.json({ ok: true, query, total: finalRows.length, rows: finalRows, csv })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message || String(err) })
  }
})

function csvEscape(v) {
  const s = (v ?? '').toString()
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

app.listen(PORT, '0.0.0.0', () => {
  console.log('Servidor rodando em http://0.0.0.0:' + PORT)
})

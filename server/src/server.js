require('dotenv').config()
const express = require('express')
const morgan = require('morgan')
const path = require('path')
const cors = require('cors')
const { textSearch, placeDetails } = require('./google')
const { toE164BR, dedupeE164 } = require('./phone')
const { validateNumbers } = require('./whatsapp')

const app = express()
const PORT = process.env.PORT || 5173

app.use(morgan('dev'))
app.use(express.json({ limit: '1mb' }))
app.use(cors())
app.use(express.static(path.join(__dirname, '../../public')))

app.get('/api/status', (_, res) => {
  res.json({
    ok: true,
    validationProvider: (process.env.VALIDATION_PROVIDER || 'NONE').toUpperCase(),
    hasPlaces: Boolean(process.env.PLACES_API_KEY)
  })
})

/**
 * Pipeline completo:
 *  - Busca empresas (Google Places) por texto "segmento in cidade"
 *  - Extrai telefones, formata para E.164
 *  - Valida via provedor (WHAPI ou NONE)
 *  - Limita ao total solicitado
 */

/**
 * Valida uma lista enviada pelo cliente (CSV ou manual).
 * Body: { numbers: ["+55...", "3199..."], country?: "BR" }
 */
app.post('/api/validate', async (req, res) => {
  try {
    const { numbers } = req.body || {}
    if (!Array.isArray(numbers) || numbers.length === 0) {
      return res.status(400).json({ error: 'Envie um array "numbers".' })
    }
    const rawList = numbers.map(n => (n ?? '').toString().trim()).filter(Boolean)

    // Mapeia raw -> e164 (quando possível)
    const mappings = rawList.map(raw => {
      const e164 = toE164BR(raw)
      return { raw, e164 }
    })

    const e164Unique = [...new Set(mappings.map(m => m.e164).filter(Boolean))]
    const provider = (process.env.VALIDATION_PROVIDER || 'NONE').toUpperCase()
    const validation = await validateNumbers({
      provider,
      numbers: e164Unique,
      whapi: { token: process.env.WHAPI_TOKEN, baseUrl: process.env.WHAPI_BASE_URL }
    })

    const statusByE164 = new Map(validation.map(v => [v.input, v.status]))
    const waIdByE164 = new Map(validation.map(v => [v.input, v.wa_id || null]))

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

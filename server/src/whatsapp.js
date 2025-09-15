const { request } = require('undici')

/**
 * Valida números via provedores externos.
 * Deve retornar: [{ input, status: 'valid'|'invalid'|'unknown', wa_id: string|null }]
 */
async function validateNumbers({ provider, numbers, whapi }) {
  switch ((provider || 'NONE').toUpperCase()) {
    case 'WHAPI':
      return await validateWithWhapi(numbers, whapi)
    case 'NONE':
    default:
      return numbers.map(n => ({ input: n, status: 'unknown', wa_id: null }))
  }
}

async function validateWithWhapi(numbers, { token, baseUrl }) {
  if (!token) throw new Error('WHAPI_TOKEN não configurado')
  const url = (baseUrl || 'https://gate.whapi.cloud').replace(/\/$/, '') + '/contacts'
  // WHAPI aceita lotes grandes, mas vamos em blocos de 100 para segurança
  const chunks = []
  for (let i = 0; i < numbers.length; i += 100) chunks.push(numbers.slice(i, i + 100))

  const out = []
  for (const chunk of chunks) {
    const res = await request(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        blocking: 'wait',
        contacts: chunk,
        force_check: true
      })
    })
    if (res.statusCode >= 400) {
      const text = await res.body.text()
      throw new Error(`WHAPI erro ${res.statusCode}: ${text}`)
    }
    const data = await res.body.json()
    // Normaliza: alguns provedores retornam { contacts: [{input, status, wa_id}] }
    const items = (data.contacts || data || [])
    for (const c of items) {
      out.push({
        input: c.input || c.number || c.phone || null,
        status: (c.status || 'unknown').toLowerCase(),
        wa_id: c.wa_id || null
      })
    }
  }
  return out
}

module.exports = { validateNumbers }

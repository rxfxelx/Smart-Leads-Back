const { setTimeout: sleep } = require('timers/promises')
const { request } = require('undici')

/**
 * Busca lugares via Text Search (API legacy) e retorna um array de place_id.
 */
async function textSearch({ apiKey, query, region = 'br', language = 'pt-BR', maxPages = 3 }) {
  const placeIds = []
  let url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&region=${region}&language=${language}&key=${apiKey}`
  let page = 0

  while (url && page < maxPages) {
    const res = await request(url)
    const body = await res.body.json()
    if (body.status !== 'OK' && body.status !== 'ZERO_RESULTS') {
      throw new Error(`Google Places Text Search falhou: ${body.status} - ${body.error_message || ''}`)
    }
    for (const r of body.results || []) {
      if (r.place_id) placeIds.push(r.place_id)
    }
    if (body.next_page_token) {
      // Google exige ~2s antes de usar o next_page_token
      await sleep(2000)
      url = `https://maps.googleapis.com/maps/api/place/textsearch/json?pagetoken=${body.next_page_token}&key=${apiKey}`
      page += 1
    } else {
      url = null
    }
  }
  return placeIds
}

/**
 * Busca detalhes (inclui telefone) para um place_id.
 */
async function placeDetails({ apiKey, placeId }) {
  const fields = [
    'name',
    'formatted_address',
    'international_phone_number',
    'formatted_phone_number',
    'website'
  ].join(',')
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=${fields}&key=${apiKey}`
  const res = await request(url)
  const body = await res.body.json()
  if (body.status !== 'OK') return null
  const r = body.result || {}
  return {
    name: r.name || null,
    address: r.formatted_address || null,
    phone: r.international_phone_number || r.formatted_phone_number || null,
    website: r.website || null,
    place_id: placeId
  }
}

module.exports = { textSearch, placeDetails }

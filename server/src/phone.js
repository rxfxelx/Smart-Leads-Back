const { parsePhoneNumberFromString } = require('libphonenumber-js')

function toE164BR(raw) {
  if (!raw) return null
  try {
    // Remove ruídos comuns
    const cleaned = String(raw).replace(/[\s\-().]/g, '')
    // Se já começar com +, tenta parsear diretamente
    const p = parsePhoneNumberFromString(raw, 'BR')
    if (p && p.isValid()) return p.number
    // Se vier sem +55 e tiver 10-11 dígitos, tenta forçar BR
    const guess = parsePhoneNumberFromString(cleaned, 'BR')
    if (guess && guess.isValid()) return guess.number
  } catch (_) {}
  return null
}

function dedupeE164(list) {
  const seen = new Set()
  const out = []
  for (const n of list) {
    if (!n) continue
    const k = n.trim()
    if (!seen.has(k)) {
      seen.add(k)
      out.push(k)
    }
  }
  return out
}

module.exports = { toE164BR, dedupeE164 }

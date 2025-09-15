require('dotenv').config();
const express = require('express');
const morgan  = require('morgan');
const path    = require('path');
const { toE164BR, dedupeE164 } = require('./phone');

const { request } = require('undici');
const puppeteer   = require('puppeteer'); // <— busca manual (Google -> sites)
const app  = express();
const PORT = process.env.PORT || 5173;

// --------- Middlewares básicos ----------
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));

// --------- CORS robusto + preflight ----------
const ALLOWED = (process.env.CORS_ORIGINS || 'https://smart-leads-front.vercel.app,http://localhost:5173')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED.includes(origin) || process.env.CORS_ANY === '1')) {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ANY === '1' ? '*' : origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// (Opcional) servir o front estático se estiver no mesmo app:
app.use(express.static(path.join(__dirname, '../../public')));

app.get('/api/status', (_, res) => {
  res.json({
    ok: true,
    validationProvider: 'CLICK2CHAT',
    searchMode: 'MANUAL (Google SERP + raspagem)'
  });
});

/**
 * Valida números consultando a página pública de Click-to-Chat do WhatsApp (heurístico)
 */
async function validateViaClickToChat(e164Numbers = []) {
  const out = [];
  for (const num of e164Numbers) {
    const phone = (num || '').replace(/^\+/, '');
    const url = `https://api.whatsapp.com/send?phone=${phone}`;
    let status = 'unknown';
    try {
      const res = await request(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0 Safari/537.36'
        }
      });
      const html = await res.body.text();
      if (/invalid phone number|número de telefone .* inválido/i.test(html)) {
        status = 'invalid';
      } else if (/continue to chat|continuar para (o )?chat|continuar para a conversa/i.test(html)) {
        status = 'valid';
      } else {
        status = 'unknown';
      }
    } catch {
      status = 'unknown';
    }
    out.push({ input: num, status, wa_id: phone });
    await new Promise(r => setTimeout(r, 300)); // ser gentil com o endpoint
  }
  return out;
}

/**
 * Busca manual: Google -> links orgânicos -> visita site -> extrai telefones
 */
async function manualSearch({ city, segment, total }) {
  const query = `${segment && segment.trim().length ? segment : 'empresas'} ${city} telefone`;
  const maxLinks = Math.min((total || 50) * 5, 80);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0 Safari/537.36'
  );

  const links = [];
  let start = 0;

  try {
    while (links.length < maxLinks && start < 100) {
      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=pt-BR&num=10&start=${start}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

      // Pega links orgânicos a partir de /url?q=...
      const urls = await page.$$eval('a[href^="https://www.google.com/url?"]', as => {
        const ps = new URLSearchParams();
        const out = [];
        for (const a of as) {
          try {
            const href = new URL(a.href);
            const q = href.searchParams.get('q');
            if (q && /^https?:\/\//i.test(q)) out.push(q);
          } catch {}
        }
        return Array.from(new Set(out));
      });

      for (const u of urls) {
        if (links.length >= maxLinks) break;
        // ignora domínios muito genéricos ou do próprio Google
        if (/(google|gstatic)\./i.test(u)) continue;
        links.push(u);
      }
      start += 10;
    }

    // Visita cada link e extrai telefones
    const results = [];
    const sub = await browser.newPage();
    for (const url of links) {
      try {
        await sub.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        // 1) tel: links
        const telLinks = await sub.$$eval('a[href^="tel:"]', as =>
          as.map(a => (a.getAttribute('href') || '').replace(/^tel:/i, ''))
        );
        // 2) texto da página
        const text = await sub.evaluate(() => document.body ? document.body.innerText : '');
        const title = await sub.title();
        const phoneCandidates = [
          ...telLinks,
          ...Array.from(
            (text || '').matchAll(/(\+?55\s*)?(\(?\d{2}\)?\s*)?(?:9?\d{4})[-.\s]?\d{4}/g)
          ).map(m => m[0])
        ];

        const normalized = [];
        for (const raw of phoneCandidates) {
          // envia para o servidor normalizar (BR E.164)
          // vamos só empurrar agora; a limpeza real será feita depois com toE164BR
          normalized.push(raw);
        }

        const domain = (() => { try { return new URL(url).hostname; } catch { return url; } })();
        results.push({
          url,
          title: title || domain,
          rawPhones: normalized
        });
      } catch {
        // ignora erros de site individual
      }
      if (results.length >= maxLinks) break;
    }

    // Normalizar + deduplicar
    const enriched = [];
    const seen = new Set();
    for (const r of results) {
      for (const raw of r.rawPhones) {
        const e164 = toE164BR(raw);
        if (!e164) continue;
        if (seen.has(e164)) continue;
        seen.add(e164);
        enriched.push({
          name: r.title || '',
          phone_e164: e164,
          address: '',
          source: r.url
        });
        if (enriched.length >= (total || 50) * 2) break;
      }
      if (enriched.length >= (total || 50) * 2) break;
    }

    // Deduplica final e corta no total
    const uniquePhones = dedupeE164(enriched.map(e => e.phone_e164)).slice(0, total || 50);
    const uniqueSet = new Set(uniquePhones);
    const compact = enriched.filter(e => uniqueSet.has(e.phone_e164));

    return compact;
  } finally {
    await browser.close();
  }
}

// --------- ENDPOINT: validar CSV/Manual (Click-to-Chat) ----------
app.post('/api/validate', async (req, res) => {
  try {
    const { numbers } = req.body || {};
    if (!Array.isArray(numbers) || numbers.length === 0) {
      return res.status(400).json({ error: 'Envie um array "numbers".' });
    }
    const rawList = numbers.map(n => (n ?? '').toString().trim()).filter(Boolean);
    const mappings = rawList.map(raw => ({ raw, e164: toE164BR(raw) }));
    const e164Unique = [...new Set(mappings.map(m => m.e164).filter(Boolean))];
    const validation = await validateViaClickToChat(e164Unique);
    const byE164 = new Map(validation.map(v => [v.input, v.status]));
    const results = mappings.map(({ raw, e164 }) => ({
      raw,
      e164,
      status: e164 ? (byE164.get(e164) || 'unknown') : 'invalid',
      wa_id: e164 ? e164.replace(/^\+/, '') : null
    }));
    res.json({ ok: true, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// --------- ENDPOINT: run (busca manual + validação Click-to-Chat) ----------
app.post('/api/run', async (req, res) => {
  try {
    const { city, segment, total } = req.body || {};
    if (!city || String(city).trim().length < 2) {
      return res.status(400).json({ error: 'Informe a cidade ou região.' });
    }
    const max = Math.min(Number(total || 50), 200);

    // 1) Buscar manualmente
    const compact = await manualSearch({ city, segment, total: max });

    // 2) Validar via Click-to-Chat (heurístico)
    const validation = await validateViaClickToChat(compact.map(e => e.phone_e164));
    const by = new Map(validation.map(v => [v.input, v.status]));

    const finalRows = compact.map(e => ({
      name: e.name,
      phone_e164: e.phone_e164,
      wa_status: by.get(e.phone_e164) || 'unknown',
      address: e.address,
      source: e.source
    }));

    // 3) CSV
    const csvHeader = 'name,phone_e164,wa_status,address,source\n';
    const csvBody = finalRows.map(r => [
      csvEscape(r.name),
      csvEscape(r.phone_e164),
      csvEscape(r.wa_status),
      csvEscape(r.address),
      csvEscape(r.source)
    ].join(',')).join('\n');
    const csv = csvHeader + csvBody + '\n';

    res.json({ ok: true, query: `${segment || 'empresas'} ${city}`, total: finalRows.length, rows: finalRows, csv });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

function csvEscape(v) {
  const s = (v ?? '').toString();
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

app.listen(PORT, '0.0.0.0', () => {
  console.log('HTTP em http://0.0.0.0:' + PORT);
});

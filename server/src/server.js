// Carrega variáveis de ambiente do .env
require('dotenv').config();

const express = require('express');
const morgan  = require('morgan');
const path    = require('path');
const { request } = require('undici');
const { spawn } = require('child_process');
const { toE164BR } = require('./phone'); // usado em /api/validate

const app = express();
const PORT = process.env.PORT || 5173;

// helper simples de espera
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Middlewares ----------
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));

// ---------- CORS ----------
// Em produção, ajuste CORS_ORIGINS para uma lista separada por vírgulas.
const ALLOWED = (process.env.CORS_ORIGINS || 'https://smart-leads-front.vercel.app,http://localhost:5173')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (process.env.CORS_ANY === '1') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && ALLOWED.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (origin) {
    // fallback permissivo para testes
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- Rotas básicas / saúde ----------
app.use(express.static(path.join(__dirname, '../../public')));
app.get('/', (_, res) => res.type('text/plain').send('OK'));
app.get('/healthz', (_, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/api/status', (_, res) => {
  res.json({
    ok: true,
    validationProvider: 'CLICK2CHAT (on-demand)',
    searchMode: 'Python (DuckDuckGo HTML + raspagem de sites)',
    ts: Date.now()
  });
});

// ---------- Validação WhatsApp (heurística via Click-to-Chat) ----------
async function validateViaClickToChat(e164Numbers = []) {
  const out = [];
  for (const num of e164Numbers) {
    const phone = (num || '').replace(/^\+/, '');
    const url = `https://api.whatsapp.com/send?phone=${phone}`;
    let status = 'unknown';
    try {
      const res = await request(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const html = await res.body.text();
      if (/invalid phone number|número de telefone .* inválido/i.test(html)) status = 'invalid';
      else if (/continue to chat|continuar para/i.test(html)) status = 'valid';
    } catch {
      status = 'unknown';
    }
    out.push({ input: num, status, wa_id: phone });
    await sleep(200);
  }
  return out;
}

// ---------- ENDPOINTS ----------

// Valida lista enviada (CSV/upload ou os resultados de busca)
app.post('/api/validate', async (req, res) => {
  try {
    const { numbers } = req.body || {};
    if (!Array.isArray(numbers) || numbers.length === 0) {
      return res.status(400).json({ error: 'Envie um array "numbers".' });
    }
    const rawList  = numbers.map(n => (n ?? '').toString().trim()).filter(Boolean);
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

// >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
// NOVO /api/run: chama o scraper Python (NÃO usa Puppeteer)
// >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
app.post('/api/run', async (req, res) => {
  const { city, segment, total } = req.body || {};
  if (!city || String(city).trim().length < 2) {
    return res.status(400).json({ error: 'Informe a cidade ou região.' });
  }

  try {
    const args = [
      'scraper/scrape.py',
      '--city', city,
      '--segment', segment || '',
      '--total', String(Math.min(Number(total || 50), 200))
    ];
    const p = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '', err = '';
    p.stdout.on('data', d => out += d.toString('utf8'));
    p.stderr.on('data', d => err += d.toString('utf8'));

    p.on('close', code => {
      if (code !== 0) {
        // Se o script falhar, devolvemos erro e um trecho do stderr para debug
        return res.status(500).json({ error: `scraper exit ${code}`, stderr: (err || '').slice(0, 800) });
      }
      try {
        const data = JSON.parse(out);
        // Garante wa_status no retorno
        const rows = (data.rows || []).map(r => ({ ...r, wa_status: r.wa_status || 'unvalidated' }));
        res.json({
          ok: true,
          query: data.query,
          total: rows.length,
          rows,
          csv: data.csv || ''
        });
      } catch (e) {
        res.status(500).json({ error: 'Scraper retornou JSON inválido', details: e.message, preview: out.slice(0, 300) });
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Utilidade p/ CSV (aqui não usamos porque o CSV já vem do Python, mas deixei caso precise)
function csvEscape(v) {
  const s = (v ?? '').toString();
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ---------- Start ----------
app.listen(PORT, '0.0.0.0', () => {
  console.log('HTTP em http://0.0.0.0:' + PORT);
});

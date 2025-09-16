require('dotenv').config();
const express = require('express');
const morgan  = require('morgan');
const path    = require('path');
const { request } = require('undici');
const { toE164BR, dedupeE164 } = require('./phone');

// Puppeteer + Stealth
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 5173;
const HEADLESS = String(process.env.HEADLESS || 'true') !== 'false';

/* ---------- Middlewares ---------- */
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));

/* ---------- CORS ---------- */
const ALLOWED = (process.env.CORS_ORIGINS || 'https://smart-leads-front.vercel.app,http://localhost:5173')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowAny = process.env.CORS_ANY === '1';
  if (allowAny) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && ALLOWED.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (origin) {
    // fallback de debug — remova em prod se quiser estrito
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ---------- Static / Health ---------- */
app.use(express.static(path.join(__dirname, '../../public')));
app.get('/', (_, res) => res.type('text/plain').send('OK'));
app.get('/healthz', (_, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/api/status', (_, res) => {
  res.json({
    ok: true,
    validationProvider: 'CLICK2CHAT (on-demand)',
    searchMode: 'Puppeteer (Google) + fallback DuckDuckGo (decoded)',
    ts: Date.now()
  });
});

/* ---------- Scraper utils ---------- */
async function tryAcceptGoogleConsent(page) {
  try {
    const selectors = [
      '#L2AGLb',
      'button[aria-label="Aceitar tudo"]',
      'button:has-text("Aceitar tudo")',
      'button:has-text("Concordo")',
      'button:has-text("Accept all")',
      'button:has-text("I agree")'
    ];
    for (const sel of selectors) {
      const btn = await page.$(sel);
      if (btn) { await btn.click(); await page.waitForTimeout(500); break; }
    }
  } catch {}
}

// NOVO: também captura números em links do WhatsApp (wa.me / api.whatsapp.com)
async function extractPhonesFromPage(page) {
  const telLinks = await page.$$eval('a[href^="tel:"]',
    as => as.map(a => (a.getAttribute('href') || '').replace(/^tel:/i, ''))).catch(() => []);

  const waLinks = await page.$$eval('a[href*="wa.me/"], a[href*="api.whatsapp.com/send"]',
    as => as.map(a => a.href)).catch(() => []);
  const waPhones = [];
  for (const href of waLinks) {
    const m1 = href.match(/wa\.me\/(\d{10,15})/i);
    const m2 = href.match(/[?&]phone=(\d{10,15})/i);
    const raw = (m1 && m1[1]) || (m2 && m2[1]);
    if (raw) waPhones.push('+' + (raw.startsWith('55') ? raw : '55' + raw));
  }

  const text = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
  const regex = /(\+?55\s*)?(\(?\d{2}\)?\s*)?(?:9?\d{4})[-.\s]?\d{4}/g;
  const textPhones = Array.from((text || '').matchAll(regex)).map(m => m[0]);

  return [...telLinks, ...waPhones, ...textPhones];
}

async function humanGoogleSearch(browser, query, pagesToWalk = 2) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0 Safari/537.36'
  );

  await page.goto('https://www.google.com/?hl=pt-BR', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await tryAcceptGoogleConsent(page);

  const inputSel = 'textarea[name="q"], input[name="q"]';
  await page.waitForSelector(inputSel, { timeout: 15000 });
  await page.click(inputSel);
  for (const ch of query) await page.keyboard.type(ch, { delay: 50 + Math.floor(Math.random() * 80) });
  await page.keyboard.press('Enter');

  const links = [];
  for (let p = 0; p < pagesToWalk; p++) {
    await page.waitForTimeout(1500);

    const urls = await page.$$eval('div.yuRUbf > a, a h3', els => {
      const out = [];
      for (const el of els) {
        const a = el.tagName === 'A' ? el : el.closest('a');
        if (a && a.href) out.push(a.href);
      }
      return Array.from(new Set(out));
    }).catch(() => []);

    for (const u of urls) {
      try {
        const host = new URL(u).hostname;
        if (!/google\./i.test(host) && !/webcache|translate\.google/i.test(u)) links.push(u);
      } catch {}
    }
    if (links.length >= 50) break;

    const next = await page.$('a#pnnext, a[aria-label^="Próxima"], a[aria-label^="Next"]');
    if (!next) break;
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
      next.click()
    ]);
  }

  await page.close();
  return Array.from(new Set(links)).slice(0, 50);
}

// NOVO: decodifica links do DDG (pega o parâmetro uddg)
function decodeDuckLink(href) {
  try {
    const u = new URL(href);
    if (/duckduckgo\.com/i.test(u.hostname)) {
      const real = u.searchParams.get('uddg');
      if (real) return decodeURIComponent(real);
    }
  } catch {}
  return href;
}

async function duckduckgoLinksHttp(query, maxLinks = 30) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=br-pt&ia=web`;
  const res = await request(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    }
  });
  const html = await res.body.text();

  const raw = Array.from(html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"/g))
    .map(m => m[1])
    .filter(Boolean);

  const out = [];
  for (const href of raw) {
    const decoded = decodeDuckLink(href);
    try {
      const host = new URL(decoded).hostname;
      if (!/duckduckgo\.com/i.test(host)) out.push(decoded);
    } catch {}
  }
  return Array.from(new Set(out)).slice(0, maxLinks);
}

/* ---------- Busca principal (sem validação) ---------- */
async function manualSearch({ city, segment, total }) {
  // duas variações de consulta aumentam chance de achar telefone
  const queries = [
    `${segment && segment.trim().length ? segment : 'empresas'} ${city} telefone`,
    `${segment && segment.trim().length ? segment : 'empresas'} ${city} contato`
  ];
  const max = Math.min(Number(total || 50), 200);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--lang=pt-BR,pt'
    ]
  });

  try {
    const allLinks = new Set();

    // 1) Google (abre e digita)
    for (const q of queries) {
      try {
        const gl = await humanGoogleSearch(browser, q, 2);
        gl.forEach(u => allLinks.add(u));
      } catch (e) {
        console.log('[SCRAPER] Google falhou:', e.message || e);
      }
    }
    console.log('[SCRAPER] Google total links:', allLinks.size);

    // 2) Fallback DuckDuckGo (HTML) — agora decodificado
    if (allLinks.size < 8) {
      for (const q of queries) {
        const ddg = await duckduckgoLinksHttp(q, 30);
        ddg.forEach(u => allLinks.add(u));
      }
      console.log('[SCRAPER] DuckDuckGo total links (após merge):', allLinks.size);
    }

    // 3) Visitar sites e extrair telefones
    const page = await browser.newPage();
    const rawItems = [];
    for (const url of Array.from(allLinks)) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const title = await page.title().catch(() => '');
        const phones = await extractPhonesFromPage(page);
        if (phones.length) rawItems.push({ url, title, phones });
      } catch {}
      if (rawItems.length >= 80) break;
      await page.waitForTimeout(250 + Math.floor(Math.random() * 250));
    }
    await page.close();

    // 4) Normalizar + deduplicar (E.164 BR)
    const enriched = [];
    const seen = new Set();
    for (const r of rawItems) {
      for (const raw of r.phones) {
        const e164 = toE164BR(raw);
        if (!e164 || seen.has(e164)) continue;
        seen.add(e164);
        enriched.push({
          name: r.title || '',
          phone_e164: e164,
          address: '',
          source: r.url,
          wa_status: 'unvalidated' // NÃO validamos aqui
        });
        if (enriched.length >= max * 2) break;
      }
      if (enriched.length >= max * 2) break;
    }

    const uniquePhones = dedupeE164(enriched.map(e => e.phone_e164)).slice(0, max);
    const set = new Set(uniquePhones);
    const finalRows = enriched.filter(e => set.has(e.phone_e164));
    console.log('[SCRAPER] telefones encontrados:', finalRows.length);
    return finalRows;
  } finally {
    await browser.close().catch(() => {});
  }
}

/* ---------- Validação (on‑demand) ---------- */
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
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
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
    await new Promise(r => setTimeout(r, 250));
  }
  return out;
}

/* ---------- Endpoints ---------- */
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

app.post('/api/run', async (req, res) => {
  try {
    const { city, segment, total } = req.body || {};
    if (!city || String(city).trim().length < 2) {
      return res.status(400).json({ error: 'Informe a cidade ou região.' });
    }
    const max = Math.min(Number(total || 50), 200);

    const rows = await manualSearch({ city, segment, total: max });

    const csvHeader = 'name,phone_e164,wa_status,address,source\n';
    const csvBody = rows.map(r => [
      csvEscape(r.name), csvEscape(r.phone_e164), 'unvalidated',
      csvEscape(r.address), csvEscape(r.source)
    ].join(',')).join('\n');
    const csv = csvHeader + csvBody + '\n';

    res.json({ ok: true, query: `${segment || 'empresas'} ${city}`, total: rows.length, rows, csv });
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

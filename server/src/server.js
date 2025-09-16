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

// --------- Configs ----------
const app = express();
const PORT = process.env.PORT || 5173;
const HEADLESS = String(process.env.HEADLESS || 'true') !== 'false';

// --------- Middlewares ----------
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));

// CORS robusto + preflight
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

// (Opcional) servir o front se estiver no mesmo app
app.use(express.static(path.join(__dirname, '../../public')));

app.get('/api/status', (_, res) => {
  res.json({
    ok: true,
    validationProvider: 'CLICK2CHAT',
    searchMode: 'Puppeteer (Google) + fallback DuckDuckGo'
  });
});

// --------- Utilitários de scraping ----------
async function tryAcceptGoogleConsent(page) {
  try {
    const candidates = [
      '#L2AGLb',
      'button[aria-label="Aceitar tudo"]',
      'button:has-text("Aceitar tudo")',
      'button:has-text("Concordo")',
      'button:has-text("Accept all")',
      'button:has-text("I agree")'
    ];
    for (const sel of candidates) {
      const btn = await page.$(sel);
      if (btn) { await btn.click(); await page.waitForTimeout(500); break; }
    }
  } catch {}
}

async function extractPhonesFromPage(page) {
  const telLinks = await page.$$eval('a[href^="tel:"]',
    as => as.map(a => (a.getAttribute('href') || '').replace(/^tel:/i, ''))).catch(() => []);
  const text = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
  const regex = /(\+?55\s*)?(\(?\d{2}\)?\s*)?(?:9?\d{4})[-.\s]?\d{4}/g;
  const textPhones = Array.from((text || '').matchAll(regex)).map(m => m[0]);
  return [...telLinks, ...textPhones];
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
  for (const ch of query) {
    await page.keyboard.type(ch, { delay: 50 + Math.floor(Math.random() * 80) });
  }
  await page.keyboard.press('Enter');

  const links = [];
  for (let p = 0; p < pagesToWalk; p++) {
    await page.waitForTimeout(1500);

    // Captura de links orgânicos em diferentes layouts
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
        if (!/google\./i.test(host) && !/webcache|translate\.google/i.test(u)) {
          links.push(u);
        }
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

async function duckduckgoLinksHttp(query, maxLinks = 30) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=br-pt&ia=web`;
  const res = await request(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    }
  });
  const html = await res.body.text();

  // Extrai links da página HTML (sem API)
  const links = Array.from(html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"/g))
    .map(m => m[1])
    .filter(Boolean);

  const filtered = [];
  for (const u of links) {
    try {
      const host = new URL(u).hostname;
      if (!/duckduckgo\.com/i.test(host)) filtered.push(u);
    } catch {}
  }
  return Array.from(new Set(filtered)).slice(0, maxLinks);
}

async function manualSearch({ city, segment, total }) {
  const query = `${segment && segment.trim().length ? segment : 'empresas'} ${city} telefone`;
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
    // 1) Tenta Google (abrindo e digitando)
    let links = [];
    try {
      links = await humanGoogleSearch(browser, query, 2);
      console.log('[SCRAPER] Google links:', links.length);
    } catch (e) {
      console.log('[SCRAPER] Google falhou:', e.message || e);
    }

    // 2) Fallback DuckDuckGo (HTTP simples) se Google deu poucos links
    if (links.length < 5) {
      const ddg = await duckduckgoLinksHttp(query, 30);
      console.log('[SCRAPER] DuckDuckGo links:', ddg.length);
      links = Array.from(new Set([...links, ...ddg]));
    }

    // 3) Visita os sites e extrai telefones
    const page = await browser.newPage();
    const rawItems = [];
    for (const url of links) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const title = await page.title().catch(() => '');
        const phones = await extractPhonesFromPage(page);
        rawItems.push({ url, title, phones });
      } catch (e) {
        // ignora site problemático
      }
      if (rawItems.length >= 60) break;
      await page.waitForTimeout(250 + Math.floor(Math.random() * 250));
    }
    await page.close();

    // 4) Normaliza p/ E.164 BR + deduplica
    const enriched = [];
    const seen = new Set();
    for (const r of rawItems) {
      for (const raw of r.phones) {
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
        if (enriched.length >= max * 2) break;
      }
      if (enriched.length >= max * 2) break;
    }

    const uniquePhones = dedupeE164(enriched.map(e => e.phone_e164)).slice(0, max);
    const set = new Set(uniquePhones);
    return enriched.filter(e => set.has(e.phone_e164));
  } finally {
    await browser.close().catch(() => {});
  }
}

// --------- Validação Click-to-Chat (heurística) ----------
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
    await new Promise(r => setTimeout(r, 300));
  }
  return out;
}

// --------- Endpoints ----------
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

    // 1) Buscar manualmente
    const compact = await manualSearch({ city, segment, total: max });
    console.log('[SCRAPER] telefones encontrados (pré-validação):', compact.length);

    // 2) Validar via Click-to-Chat
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

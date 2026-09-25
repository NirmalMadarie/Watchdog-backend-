/* =====================================================================
   WATCHDOG BACKEND (RC7) — veilige proxy voor Live Search, met wisselbare zoekbron.
   - De geheime API-sleutels blijven op de server. De frontend (GitHub Pages) kent ze nooit.
   - Zoekbronnen: SerpApi en Serper (beide Google + Google Shopping). Kies met SEARCH_PROVIDER.
     Geeft de gekozen bron een fout of is het tegoed op, dan probeert de backend automatisch de andere.
   - Bevat GEEN mock-/demodata: zonder geldige sleutel geeft /api/search eerlijk 'not-configured' terug.
   - Het antwoordformaat is gelijk aan RC6, dus index.html hoeft niet te veranderen.
   ===================================================================== */
const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 8787;
const ORIGIN = process.env.WATCHDOG_ORIGIN || '';

// ---- Zoekbronnen: sleutels en keuze ----
const KEYS = {
  serpapi: process.env.SERPAPI_KEY || '',
  serper: process.env.SERPER_API_KEY || '',
};
const PREFERRED = String(process.env.SEARCH_PROVIDER || 'serpapi').trim().toLowerCase();
const FALLBACK_ON = String(process.env.SEARCH_FALLBACK || 'aan').trim().toLowerCase() !== 'uit';
const COUNTRY = process.env.SEARCH_COUNTRY || 'nl';
const LANGUAGE = process.env.SEARCH_LANGUAGE || 'nl';
// Beschermt je gratis tegoed: maximaal zoveel ECHTE aanroepen naar de zoekbronnen per dag (cache telt niet mee).
const DAILY_LIMIT = Math.max(0, parseInt(process.env.SEARCH_DAILY_LIMIT || '80', 10) || 0);
// Hoe lang een identieke zoekopdracht uit de cache komt (minuten). Scheelt tegoed en is sneller.
const CACHE_MINUTES = Math.max(0, parseInt(process.env.SEARCH_CACHE_MINUTES || '360', 10) || 0);
const UPSTREAM_TIMEOUT_MS = 15000;

const PROVIDER_NAMES = {
  serpapi: 'Google Shopping (via SerpApi)',
  serper: 'Google Shopping (via Serper)',
};

function providerOrder() {
  const all = ['serpapi', 'serper'].filter(p => KEYS[p]);
  if (!all.length) return [];
  const first = all.includes(PREFERRED) ? PREFERRED : all[0];
  const rest = all.filter(p => p !== first);
  return FALLBACK_ON ? [first, ...rest] : [first];
}

const app = express();
app.set('trust proxy', 1); // Render zet een proxy voor de app; zo klopt req.ip
app.use(express.json({ limit: '20kb' }));

// ---- CORS: alleen de eigen WATCHDOG-frontend mag deze backend aanroepen ----
// WATCHDOG_ORIGIN mag ook een volledig adres zijn (bijv. https://naam.github.io/watchdog/#/home):
// we halen er zelf alleen het domeindeel uit, want de browser stuurt alleen "https://naam.github.io".
function toOrigin(s) {
  s = String(s || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { return new URL(s).origin.toLowerCase(); } catch (e) { return null; }
}
const ALLOWED_ORIGINS = ORIGIN.split(',').map(toOrigin).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => cb(null, !!origin && ALLOWED_ORIGINS.includes(String(origin).toLowerCase())),
  methods: ['GET', 'POST'],
}));

// ---- eenvoudige rate limit per IP ----
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 60000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) { for (const [k, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(k); }
  return recent.length > 30; // max 30 requests/minuut/IP
}

// ---- dagteller (per UTC-dag) ----
let day = new Date().toISOString().slice(0, 10);
let usedToday = 0;
const usedPerProvider = { serpapi: 0, serper: 0 };
function countUpstream(p) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; usedToday = 0; usedPerProvider.serpapi = 0; usedPerProvider.serper = 0; }
  usedToday++; usedPerProvider[p]++;
}
function dailyLimitReached() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) return false;
  return DAILY_LIMIT > 0 && usedToday >= DAILY_LIMIT;
}

// ---- cache ----
const cache = new Map();
function cacheGet(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.t > CACHE_MINUTES * 60000) { cache.delete(k); return null; }
  return e.v;
}
function cachePut(k, v) {
  if (!CACHE_MINUTES) return;
  cache.set(k, { t: Date.now(), v });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
}

// ---- zoekvraag opschonen: "zoek een wasmachine onder 500 euro" -> "wasmachine onder 500 euro" ----
function cleanQuery(q) {
  let s = String(q || '').trim();
  s = s.replace(/^(hey|hoi|hallo)[,!\s]+/i, '');
  s = s.replace(/^(kun|kan|wil)\s+(je|jij|u)\s+(voor\s+mij\s+)?/i, '');
  s = s.replace(/^(ik\s+)?(zoek|zoeken|zoekt|op\s+zoek\s+naar)\s+(naar\s+)?/i, '');
  s = s.replace(/^(een|de|het)\s+/i, '');
  s = s.replace(/\s+(voor\s+mij\s+)?(zoeken|opzoeken)\??$/i, '');
  s = s.replace(/[?!.]+$/, '').trim();
  return s || String(q || '').trim();
}

// ---- prijs uit tekst: "€ 1.299,00", "€499.99", "1.299 €" ----
function parsePrice(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/[^\d.,]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');          // 1.299,00
  else if (lastDot > lastComma && lastComma >= 0) s = s.replace(/,/g, '');      // 1,299.00
  else if (lastComma >= 0 && s.length - lastComma - 1 !== 3) s = s.replace(',', '.'); // 499,9
  else if (lastComma >= 0) s = s.replace(',', '');                              // 1,299
  else if (lastDot >= 0 && s.length - lastDot - 1 === 3) s = s.replace(/\./g, '');  // 1.299 (Nederlandse duizendtallen)
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function currencyOf(v) {
  const s = String(v || '');
  if (/€|EUR/i.test(s)) return 'EUR';
  if (/\$|USD/i.test(s)) return 'USD';
  if (/£|GBP/i.test(s)) return 'GBP';
  return null;
}
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return null; } }

// ---- fetch met timeout; geeft een duidelijke fout met HTTP-status ----
async function fetchJson(url, opts) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
    const txt = await r.text();
    let data = null;
    try { data = JSON.parse(txt); } catch (e) {}
    if (!r.ok) { const err = new Error('HTTP ' + r.status); err.status = r.status; err.body = txt.slice(0, 500); throw err; }
    return data || {};
  } catch (e) {
    if (e && e.name === 'AbortError') { const err = new Error('timeout'); err.status = 504; throw err; }
    throw e;
  } finally { clearTimeout(t); }
}

// =====================================================================
// Bron 1: SerpApi — https://serpapi.com  (engine=google_shopping, daarna engine=google)
// =====================================================================
async function serpapiShopping(q) {
  const u = new URL('https://serpapi.com/search.json');
  u.search = new URLSearchParams({ engine: 'google_shopping', q, gl: COUNTRY, hl: LANGUAGE, google_domain: 'google.' + COUNTRY, api_key: KEYS.serpapi }).toString();
  const d = await fetchJson(u.toString());
  if (d.error && !/hasn't returned any results/i.test(d.error)) { const e = new Error(d.error); e.status = 502; e.body = d.error; throw e; }
  const list = [].concat(d.shopping_results || [], d.inline_shopping_results || []);
  return list.map(it => {
    const url = it.link || it.product_link || '';
    return {
      title: it.title || '',
      url,
      snippet: [it.delivery, it.extensions && it.extensions.join(' · ')].filter(Boolean).join(' · '),
      image: it.thumbnail || null,
      source: it.source || hostOf(url),
      attributes: {
        price: parsePrice(it.price) != null ? parsePrice(it.price) : parsePrice(it.extracted_price),
        priceText: it.price || null,
        currency: currencyOf(it.price) || 'EUR',
        availability: it.delivery || null,
        brand: null,
      },
    };
  }).filter(x => x.url);
}
async function serpapiWeb(q) {
  const u = new URL('https://serpapi.com/search.json');
  u.search = new URLSearchParams({ engine: 'google', q, gl: COUNTRY, hl: LANGUAGE, google_domain: 'google.' + COUNTRY, num: '10', api_key: KEYS.serpapi }).toString();
  const d = await fetchJson(u.toString());
  if (d.error && !/hasn't returned any results/i.test(d.error)) { const e = new Error(d.error); e.status = 502; e.body = d.error; throw e; }
  return (d.organic_results || []).map(it => {
    const rich = (it.rich_snippet && (it.rich_snippet.top || it.rich_snippet.bottom)) || {};
    const ext = rich.detected_extensions || {};
    return {
      title: it.title || '', url: it.link || '', snippet: it.snippet || '', image: it.thumbnail || null,
      source: it.source || hostOf(it.link),
      attributes: { price: parsePrice(ext.price), currency: ext.currency || null, availability: null, brand: null },
    };
  }).filter(x => x.url);
}

// =====================================================================
// Bron 2: Serper — https://serper.dev  (/shopping, daarna /search)
// =====================================================================
async function serperCall(path, q) {
  return fetchJson('https://google.serper.dev/' + path, {
    method: 'POST',
    headers: { 'X-API-KEY': KEYS.serper, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, gl: COUNTRY, hl: LANGUAGE }),
  });
}
async function serperShopping(q) {
  const d = await serperCall('shopping', q);
  return (d.shopping || []).map(it => ({
    title: it.title || '', url: it.link || '', snippet: it.delivery || '', image: it.imageUrl || null,
    source: it.source || hostOf(it.link),
    attributes: { price: parsePrice(it.price), priceText: it.price || null, currency: currencyOf(it.price) || 'EUR', availability: it.delivery || null, brand: null },
  })).filter(x => x.url);
}
async function serperWeb(q) {
  const d = await serperCall('search', q);
  return (d.organic || []).map(it => ({
    title: it.title || '', url: it.link || '', snippet: it.snippet || '', image: it.imageUrl || null,
    source: hostOf(it.link),
    attributes: { price: parsePrice(it.price), currency: currencyOf(it.price), availability: null, brand: null },
  })).filter(x => x.url);
}

// ---- Prijscontrole: een prijs die sterk afwijkt van de rest (bijv. huur per maand, of een verkeerd gelezen bedrag)
// tonen we NIET als koopprijs. De prijs wordt dan null ("niet bevestigd") en het resultaat komt achteraan.
function markSuspectPrices(results) {
  const prices = results.map(r => r.attributes && r.attributes.price).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (prices.length < 5) return results;
  const median = prices[Math.floor(prices.length / 2)];
  const ok = [], suspect = [];
  for (const r of results) {
    const a = r.attributes || {};
    const v = a.price;
    const perMonth = /(p\/?m|per\s*maand|\/\s*m(nd|aand)|mnd)/i.test(String(a.priceText || '') + ' ' + (r.snippet || ''));
    if (Number.isFinite(v) && (perMonth || v < median * 0.25 || v > median * 4)) {
      a.suspectPrice = v; a.price = null;
      a.priceNote = perMonth ? 'prijs per maand (huur of abonnement)' : 'prijs wijkt sterk af, niet bevestigd';
      suspect.push(r);
    } else ok.push(r);
  }
  return ok.concat(suspect);
}

const PROVIDERS = {
  serpapi: { shopping: serpapiShopping, web: serpapiWeb },
  serper: { shopping: serperShopping, web: serperWeb },
};

// Eerst Google Shopping (prijzen); levert dat niets op, dan gewone Google-resultaten.
// Elke echte aanroep telt voor de daglimiet.
async function searchWith(p, q) {
  countUpstream(p);
  let results = await PROVIDERS[p].shopping(q);
  let kind = 'shopping';
  if (!results.length) {
    if (dailyLimitReached()) return { results, kind };
    countUpstream(p);
    results = await PROVIDERS[p].web(q);
    kind = 'web';
  }
  return { results: markSuspectPrices(results).slice(0, 20), kind };
}

// ---- /api/health — GEEFT NOOIT SECRETS TERUG ----
app.get('/api/health', (req, res) => {
  const order = providerOrder();
  res.json({
    backend: 'online',
    liveSearch: order.length ? 'configured' : 'not-configured',
    provider: order[0] || null,
    fallback: order.slice(1),
    usedToday,
    dailyLimit: DAILY_LIMIT || null,
    version: 'RC7.2',
    time: new Date().toISOString(),
  });
});

// ---- /api/search ----
app.post('/api/search', async (req, res) => {
  if (rateLimited(req.ip || 'unknown')) {
    return res.status(429).json({ ok: false, error: 'te veel aanvragen, probeer het over een minuut opnieuw' });
  }
  const raw = String((req.body && req.body.query) || '').trim();
  if (!raw || raw.length > 300) return res.status(400).json({ ok: false, error: 'ongeldige zoekopdracht' });

  const order = providerOrder();
  if (!order.length) {
    return res.json({
      ok: false, isLive: false, source: 'Live Search', sourceType: 'not-configured', fetchedAt: new Date().toISOString(), results: [],
      error: 'Live Search is nog niet geconfigureerd op deze backend (geen SERPAPI_KEY of SERPER_API_KEY ingesteld).',
    });
  }

  const q = cleanQuery(raw);
  const cacheKey = q.toLowerCase();
  const hit = cacheGet(cacheKey);
  if (hit) return res.json(Object.assign({}, hit, { cached: true }));

  if (dailyLimitReached()) {
    return res.status(429).json({ ok: false, error: 'de daglimiet voor live zoeken is bereikt; morgen werkt het weer' });
  }

  const failures = [];
  for (const p of order) {
    try {
      const { results, kind } = await searchWith(p, q);
      const body = {
        ok: true,
        isLive: true,
        source: kind === 'shopping' ? PROVIDER_NAMES[p] : PROVIDER_NAMES[p].replace('Google Shopping', 'Google'),
        sourceType: 'live-search',
        provider: p,
        query: q,
        fetchedAt: new Date().toISOString(),
        results,
      };
      if (failures.length) console.warn('Live Search: overgeschakeld naar ' + p + ' na fout bij ' + failures.join(', '));
      cachePut(cacheKey, body);
      return res.json(body);
    } catch (e) {
      console.error('Live Search via ' + p + ' mislukt (' + (e.status || e.message) + '):', String(e.body || e.message || '').slice(0, 500));
      failures.push(p + ' (' + (e.status || e.message) + ')');
      if (dailyLimitReached()) break;
    }
  }
  return res.status(502).json({ ok: false, error: 'de externe zoekbron gaf een fout terug (' + failures.join(', ') + ')' });
});

// ---- nette 404 en generieke foutafhandeling, nooit een stack trace naar de gebruiker ----
app.use((req, res) => res.status(404).json({ ok: false, error: 'onbekende route' }));
app.use((err, req, res, next) => {
  console.error('WATCHDOG backend error:', err && err.message);
  res.status(500).json({ ok: false, error: 'interne serverfout' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    const order = providerOrder();
    console.log(`WATCHDOG backend RC7 luistert op poort ${PORT} — Live Search: ${order.length ? order.join(' → ') : 'NIET GECONFIGUREERD'}`);
  });
}
module.exports = { app, cleanQuery, parsePrice };

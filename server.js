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

// ---- AI-assistent (Mistral AI, Frankrijk). Sleutel alleen op de server. ----
const MISTRAL_KEY = process.env.MISTRAL_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'mistral-small-latest';
const AI_DAILY_LIMIT = Math.max(0, parseInt(process.env.AI_DAILY_LIMIT || '300', 10) || 0);   // totaal per dag
const AI_USER_LIMIT = Math.max(1, parseInt(process.env.AI_USER_DAILY_LIMIT || '25', 10) || 25); // per gebruiker (IP) per dag

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
        rating: Number.isFinite(+it.rating) && +it.rating > 0 ? +it.rating : null,
        reviews: Number.isFinite(+it.reviews) && +it.reviews > 0 ? +it.reviews : null,
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
    attributes: { price: parsePrice(it.price), priceText: it.price || null, currency: currencyOf(it.price) || 'EUR', availability: it.delivery || null, brand: null, rating: Number.isFinite(+it.rating) && +it.rating > 0 ? +it.rating : null, reviews: Number.isFinite(+it.ratingCount) && +it.ratingCount > 0 ? +it.ratingCount : null },
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

// ---- AI: tellers per dag ----
let aiDay = new Date().toISOString().slice(0, 10), aiUsed = 0;
const aiPerIp = new Map();
function aiAllowed(ip) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== aiDay) { aiDay = today; aiUsed = 0; aiPerIp.clear(); }
  if (AI_DAILY_LIMIT > 0 && aiUsed >= AI_DAILY_LIMIT) return 'de daglimiet van de AI-assistent is bereikt; morgen werkt het weer';
  const n = aiPerIp.get(ip) || 0;
  if (n >= AI_USER_LIMIT) return 'je hebt vandaag je maximum aantal AI-vragen gesteld; morgen kan het weer';
  aiPerIp.set(ip, n + 1); aiUsed++;
  return null;
}
const AI_SYSTEM = [
  'Je bent de assistent van WATCHDOG, een Nederlandse app die mensen helpt meer uit hun geld te halen.',
  'Antwoord altijd in eenvoudig Nederlands, kort (maximaal 150 woorden), vriendelijk en concreet.',
  'Gebruik de meegestuurde cijfers van de gebruiker als die relevant zijn en reken ze correct door. Verzin geen cijfers, tarieven, regelingen of producten.',
  'Weet je iets niet zeker (zoals actuele bedragen of regels), zeg dat dan en verwijs naar de officiële bron (bijvoorbeeld toeslagen.nl, belastingdienst.nl, rijksoverheid.nl of de eigen gemeente).',
  'Je geeft geen persoonlijk financieel advies en raadt geen specifieke financiële producten, banken of verzekeraars aan. Je geeft uitleg, rekenvoorbeelden en algemene tips. De gebruiker beslist zelf.',
  'Voor het zoeken van producten en prijzen kan de gebruiker in de app typen: "zoek …".',
].join(' ');

// ---- /api/ai — beantwoordt een vrije vraag met de (anonieme) cijfers als context ----
app.post('/api/ai', async (req, res) => {
  if (rateLimited(req.ip || 'unknown')) return res.status(429).json({ ok: false, error: 'te veel aanvragen, probeer het over een minuut opnieuw' });
  if (!MISTRAL_KEY) return res.json({ ok: false, sourceType: 'not-configured', error: 'De AI-assistent is nog niet ingesteld op de server.' });
  const q = String((req.body && req.body.question) || '').trim();
  if (!q || q.length > 500) return res.status(400).json({ ok: false, error: 'ongeldige vraag' });
  const ctx = req.body && typeof req.body.context === 'object' && req.body.context ? req.body.context : {};
  const ctxTxt = JSON.stringify(ctx).slice(0, 2000);
  const blocked = aiAllowed(req.ip || 'unknown');
  if (blocked) return res.status(429).json({ ok: false, error: blocked });
  try {
    const d = await fetchJson('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + MISTRAL_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: AI_MODEL, temperature: 0.3, max_tokens: 400,
        messages: [
          { role: 'system', content: AI_SYSTEM },
          { role: 'user', content: 'Mijn cijfers (per maand, in euro, zelf ingevuld in de app): ' + ctxTxt + '\n\nMijn vraag: ' + q },
        ],
      }),
    });
    const answer = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    if (!answer) throw Object.assign(new Error('leeg antwoord'), { status: 502 });
    return res.json({ ok: true, source: 'Mistral AI (' + AI_MODEL + ')', answer: String(answer).trim(), fetchedAt: new Date().toISOString() });
  } catch (e) {
    console.error('AI-vraag mislukt (' + (e.status || e.message) + '):', String(e.body || e.message || '').slice(0, 500));
    return res.status(502).json({ ok: false, error: 'de AI-dienst gaf een fout terug (' + (e.status || e.message) + ')' });
  }
});

// ---- /api/health — GEEFT NOOIT SECRETS TERUG ----
app.get('/api/health', (req, res) => {
  const order = providerOrder();
  res.json({
    backend: 'online',
    liveSearch: order.length ? 'configured' : 'not-configured',
    provider: order[0] || null,
    fallback: order.slice(1),
    usedToday,
    ai: MISTRAL_KEY ? 'configured' : 'not-configured',
    tts: ttsReady() ? 'configured' : 'not-configured',
    regelingen: 'live (CVDR)',
    ttsProvider: ttsReady() ? TTS_PROVIDER : null,
    ttsVoice: ttsReady() && TTS_PROVIDER !== 'elevenlabs' ? TTS_VOICE : (ttsReady() ? 'eigen stem' : null),
    dailyLimit: DAILY_LIMIT || null,
    version: 'RC10',
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


// =====================================================================
// ---- /api/tts — natuurlijke stem voor de hond (RC9) ----
// Provider kiezen met TTS_PROVIDER: 'azure' | 'elevenlabs' | 'google' | 'openai'. Sleutels staan ALLEEN hier op de server.
//   azure      : AZURE_SPEECH_KEY + AZURE_SPEECH_REGION (bijv. westeurope)   stem: TTS_VOICE (standaard nl-NL-MaartenNeural)
//   elevenlabs : ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID                     model: ELEVENLABS_MODEL (standaard eleven_multilingual_v2)
//   google     : GOOGLE_TTS_KEY                                              stem: TTS_VOICE (standaard nl-NL-Chirp3-HD-Charon)
//   openai     : OPENAI_API_KEY                                              stem: TTS_VOICE (standaard ash)
// Grenzen: max 600 tekens per verzoek, TTS_DAILY_CHARS per dag (standaard 40000), cache voor vaste zinnen.
// =====================================================================
const TTS_PROVIDER = String(process.env.TTS_PROVIDER || '').trim().toLowerCase();
const TTS_KEYS = {
  azure: process.env.AZURE_SPEECH_KEY || '',
  elevenlabs: process.env.ELEVENLABS_API_KEY || '',
  google: process.env.GOOGLE_TTS_KEY || '',
  openai: process.env.OPENAI_API_KEY || '',
};
const TTS_DEFAULT_VOICE = { azure: 'nl-NL-MaartenNeural', google: 'nl-NL-Chirp3-HD-Charon', openai: 'ash', elevenlabs: process.env.ELEVENLABS_VOICE_ID || '' };
const TTS_VOICE = process.env.TTS_VOICE || TTS_DEFAULT_VOICE[TTS_PROVIDER] || '';
const TTS_RATE = Math.min(1.3, Math.max(0.8, parseFloat(process.env.TTS_RATE || '1.04') || 1.04)); // ~150 woorden/min
const TTS_DAILY_CHARS = Math.max(0, parseInt(process.env.TTS_DAILY_CHARS || '40000', 10) || 0);
function ttsReady() {
  if (!TTS_PROVIDER || !TTS_KEYS[TTS_PROVIDER]) return false;
  if (TTS_PROVIDER === 'azure' && !process.env.AZURE_SPEECH_REGION) return false;
  if (TTS_PROVIDER === 'elevenlabs' && !TTS_VOICE) return false;
  return true;
}
let ttsDay = '', ttsChars = 0;
function ttsBudget(n) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== ttsDay) { ttsDay = today; ttsChars = 0; }
  if (TTS_DAILY_CHARS > 0 && ttsChars + n > TTS_DAILY_CHARS) return false;
  ttsChars += n; return true;
}
const ttsCache = new Map(); // kleine cache (vaste zinnen zoals begroetingen)
function ttsCacheGet(k) { const v = ttsCache.get(k); if (!v) return null; ttsCache.delete(k); ttsCache.set(k, v); return v; }
function ttsCachePut(k, buf) { if (buf.length > 400000) return; ttsCache.set(k, buf); while (ttsCache.size > 120) ttsCache.delete(ttsCache.keys().next().value); }
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
// tekst uitspreekbaar maken: bedragen, afkortingen, merknaam, geen emoji
function ttsClean(t) {
  return String(t || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/€\s?(\d+(?:[.,]\d{1,2})?)/g, (m, n) => n.replace('.', ',') + ' euro')
    .replace(/\bWATCHDOG\b/g, 'Watchdog')
    .replace(/\bp\/m\b|\/mnd\b|per mnd\b/gi, ' per maand')
    .replace(/\s+/g, ' ').trim();
}
async function ttsFetch(url, opts) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; e.body = await r.text().catch(() => ''); throw e; }
    return r;
  } finally { clearTimeout(tm); }
}
const TTS = {
  async azure(text, voice) {
    const pct = Math.round((TTS_RATE - 1) * 100);
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="nl-NL"><voice name="${xmlEsc(voice)}"><prosody rate="${pct >= 0 ? '+' : ''}${pct}%" pitch="+2%">${xmlEsc(text)}</prosody></voice></speak>`;
    const r = await ttsFetch(`https://${process.env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST', body: ssml,
      headers: { 'Ocp-Apim-Subscription-Key': TTS_KEYS.azure, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'watchdog-backend' },
    });
    return Buffer.from(await r.arrayBuffer());
  },
  async elevenlabs(text, voice) {
    const model = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
    const body = { text, model_id: model, voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true, speed: TTS_RATE } };
    if (/flash|turbo/.test(model)) body.language_code = 'nl';
    const r = await ttsFetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_64`, {
      method: 'POST', body: JSON.stringify(body), headers: { 'xi-api-key': TTS_KEYS.elevenlabs, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    });
    return Buffer.from(await r.arrayBuffer());
  },
  async google(text, voice) {
    const r = await ttsFetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(TTS_KEYS.google), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { text }, voice: { languageCode: 'nl-NL', name: voice }, audioConfig: { audioEncoding: 'MP3', speakingRate: TTS_RATE } }),
    });
    const j = await r.json(); return Buffer.from(j.audioContent || '', 'base64');
  },
  async openai(text, voice) {
    const r = await ttsFetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + TTS_KEYS.openai, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts', voice, input: text, response_format: 'mp3', speed: TTS_RATE,
        instructions: 'Spreek Nederlands (Nederland, geen Vlaams accent). Je bent WATCHDOG, een vrolijke, warme en betrouwbare beagle die mensen helpt geld te besparen. Glimlach in je stem, levendige intonatie, rustig en duidelijk bij bedragen en advies.' }),
    });
    return Buffer.from(await r.arrayBuffer());
  },
};
app.post('/api/tts', async (req, res) => {
  if (!ttsReady()) return res.status(503).json({ ok: false, sourceType: 'not-configured', error: 'De stem is nog niet ingesteld op de server.' });
  if (rateLimited(req.ip || 'unknown')) return res.status(429).json({ ok: false, error: 'te veel aanvragen, probeer het over een minuut opnieuw' });
  const text = ttsClean(req.body && req.body.text);
  if (!text || text.length > 600) return res.status(400).json({ ok: false, error: 'tekst ontbreekt of is te lang (max 600 tekens)' });
  const key = TTS_PROVIDER + '|' + TTS_VOICE + '|' + TTS_RATE + '|' + text;
  const hit = ttsCacheGet(key);
  const send = buf => { res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=86400', 'X-TTS-Provider': TTS_PROVIDER }); res.send(buf); };
  if (hit) return send(hit);
  if (!ttsBudget(text.length)) return res.status(429).json({ ok: false, error: 'de daglimiet voor de stem is bereikt; de app gebruikt nu de stem van je telefoon' });
  try {
    const buf = await TTS[TTS_PROVIDER](text, TTS_VOICE);
    if (!buf || buf.length < 200) throw new Error('lege audio');
    ttsCachePut(key, buf); return send(buf);
  } catch (e) {
    console.error('TTS via ' + TTS_PROVIDER + ' mislukt (' + (e.status || e.message) + '):', String(e.body || e.message || '').slice(0, 400));
    return res.status(502).json({ ok: false, error: 'de stemdienst gaf een fout terug (' + (e.status || e.message) + ')' });
  }
});


// =====================================================================
// ---- /api/regelingen — ECHTE gemeentelijke regelingen (RC10) ----
// Bron: Centrale Voorziening Decentrale Regelgeving (CVDR) via de open SRU-zoekdienst van overheid.nl
// (licentie CC-0, dagelijks bijgewerkt). Geen sleutel nodig. Alleen de gemeentenaam gaat naar de server,
// geen persoonsgegevens. Of iets bij iemand past, beoordeelt de app op het toestel en blijft "mogelijk".
// =====================================================================
const REG_CACHE = new Map(); // gemeente -> {t, body}
const REG_TTL = 12 * 3600e3;
const SRU = 'https://zoekservice.overheid.nl/sru/Search';
const REG_Q = {
  inkomen: 'minimaregelingen minimaregeling minimabeleid inkomenstoeslag kwijtschelding kindpakket meedoen meedoenregeling participatiefonds stadspas U-pas Ooievaarspas Rotterdampas Meedoenpas Gelrepas declaratieregeling bijstand energietoeslag zorgverzekering',
  wonen: 'duurzaamheidslening stimuleringslening blijverslening starterslening verduurzaming isolatie energiebesparing zonnepanelen duurzaamheid',
};
const REG_EXCL = /archief|aanwijzingsbesluit|daeb|zakelijk|algemene bijstand|verlagingen|verlagen|draagkracht|ambtelijke|handhaving|terugvordering|verhaal|cliëntenparticipatie|re-?integratie|ondernem|fraude|boete|mandaat|vereniging|sport|cultuur|organisatie|instelling|monument|bomen|personeel|raadsleden|wethouder|bestuurders|rekenkamer|bedrijven|ondernemers|evenement|horeca|kunst|onderwijshuisvesting|bouwleges|leges|precario|grafrechten|reclame|parkeer/i;
const REG_HINT = [
  [/compensatie toeslagen|herstel.*toeslagen/i, 'Ondersteuning voor mensen die gedupeerd zijn door de toeslagenaffaire.'],
  [/inkomenstoeslag/i, 'Een jaarlijkse toeslag als je al langere tijd een laag inkomen hebt.'],
  [/kwijtschelding/i, 'Geen of minder gemeentelijke belastingen (zoals afvalstoffenheffing) bij een laag inkomen.'],
  [/energietoeslag|energiekosten/i, 'Tegemoetkoming in de energiekosten bij een laag inkomen.'],
  [/zorgverzekering/i, 'Voordelige collectieve zorgverzekering via de gemeente bij een laag inkomen.'],
  [/starterslening/i, 'Een lening die helpt bij het kopen van je eerste woning.'],
  [/blijverslening/i, 'Een lening om je woning aan te passen zodat je er langer kunt blijven wonen.'],
  [/duurzaamheidslening|stimuleringslening|verduurzaming|isolatie|energiebesparing|zonnepanelen|duurzaam/i, 'Subsidie of voordelige lening om je woning te verduurzamen.'],
  [/bijzondere bijstand/i, 'Vergoeding van noodzakelijke, onverwachte kosten als je die zelf niet kunt betalen.'],
  [/kindpakket|meedoen|participatiefonds|stadspas|u-pas|ooievaarspas|rotterdampas|gelrepas|declaratie|minimaregeling|minimabeleid/i, 'Tegoed of korting voor sport, cultuur, school of meedoen bij een laag inkomen.'],
];
function xmlTag(r, tag) { const m = r.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([^<]*)<')); return m ? m[1].replace(/&amp;/g, '&').trim() : ''; }
async function sruFetch(q) {
  const url = SRU + '?' + new URLSearchParams({ version: '1.2', operation: 'searchRetrieve', 'x-connection': 'cvdr', maximumRecords: '100', query: q });
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 15000);
  try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; } return await r.text(); }
  finally { clearTimeout(tm); }
}
async function regelingenVoor(gemeente) {
  const today = new Date().toISOString().slice(0, 10), seen = new Map();
  for (const cat of Object.keys(REG_Q)) {
    const q = `creator="${gemeente.replace(/"/g, '')}" and title any "${REG_Q[cat]}" sortBy dcterms.modified/sort.descending`;
    const xml = await sruFetch(q);
    for (const r of xml.split('<record>').slice(1)) {
      if (!/scheme="overheid:Gemeente"/.test(r)) continue;
      const creator = xmlTag(r, 'dcterms:creator'); if (creator.toLowerCase() !== gemeente.toLowerCase()) continue;
      const title = xmlTag(r, 'dcterms:title'), id = xmlTag(r, 'dcterms:identifier'), work = id.replace(/_\d+$/, '');
      const inw = xmlTag(r, 'overheidrg:inwerkingtredingDatum'), uit = xmlTag(r, 'overheidrg:uitwerkingtredingDatum');
      if (!title || REG_EXCL.test(title)) continue;
      if (uit && uit <= today) continue;                       // niet meer geldig
      if (inw && inw < '2016-01-01') continue;
      { const yr = title.match(/\b(20\d\d)\b/); if (/eenmalig|tijdelijk/i.test(title) && yr && +yr[1] < +today.slice(0, 4) - 1) continue; } // verlopen eenmalige regelingen                 // zeer oude regels zijn vaak niet meer actueel bijgehouden
      if (seen.has(work) && (seen.get(work).since || '') >= inw) continue;  // alleen de nieuwste geldende versie
      const hint = (REG_HINT.find(h => h[0].test(title)) || [null, ''])[1];
      if (!hint) continue;                                      // alleen regelingen voor inwoners met een herkenbaar doel
      seen.set(work, { id: work, version: id, title, cat, hint, since: inw || null, future: !!(inw && inw > today), modified: xmlTag(r, 'dcterms:modified') || null,
        url: xmlTag(r, 'preferred_work_url') || ('https://lokaleregelgeving.overheid.nl/' + work) });
    }
  }
  return [...seen.values()].sort((a, b) => (a.cat === b.cat ? 0 : a.cat === 'inkomen' ? -1 : 1) || String(b.since).localeCompare(String(a.since))).slice(0, 25);
}
app.get('/api/regelingen', async (req, res) => {
  if (rateLimited(req.ip || 'unknown')) return res.status(429).json({ ok: false, error: 'te veel aanvragen, probeer het over een minuut opnieuw' });
  const g = String(req.query.gemeente || '').trim();
  if (!g || g.length > 60 || !/^[\p{L}\s'().-]+$/u.test(g)) return res.status(400).json({ ok: false, error: 'ongeldige gemeentenaam' });
  const key = g.toLowerCase(), hit = REG_CACHE.get(key);
  if (hit && Date.now() - hit.t < REG_TTL) return res.json(Object.assign({}, hit.body, { cached: true }));
  try {
    const items = await regelingenVoor(g);
    const body = { ok: true, gemeente: g, source: 'Lokale wet- en regelgeving (overheid.nl, CVDR)', sourceType: 'official', fetchedAt: new Date().toISOString(), items };
    REG_CACHE.set(key, { t: Date.now(), body }); if (REG_CACHE.size > 400) REG_CACHE.delete(REG_CACHE.keys().next().value);
    return res.json(body);
  } catch (e) {
    console.error('Regelingen voor ' + g + ' mislukt (' + (e.status || e.message) + ')');
    return res.status(502).json({ ok: false, error: 'de bron voor lokale regelingen is nu niet bereikbaar' });
  }
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
    console.log(`WATCHDOG backend RC10 luistert op poort ${PORT} — Live Search: ${order.length ? order.join(' → ') : 'NIET GECONFIGUREERD'}`);
  });
}
module.exports = { app, cleanQuery, parsePrice, ttsClean };

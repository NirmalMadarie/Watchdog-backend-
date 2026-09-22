/* =====================================================================
   WATCHDOG BACKEND (RC6) — minimale, veilige proxy voor Live Search.
   Doel: de geheime API-sleutel blijft op de server. De frontend (GitHub Pages) kent de sleutel nooit.
   Bevat GEEN mock-/demodata: als er geen geldige sleutel is ingesteld, geeft /api/search eerlijk
   { ok:false, error:'not-configured' } terug — nooit verzonnen resultaten.
   ===================================================================== */
const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 8787;
const ORIGIN = process.env.WATCHDOG_ORIGIN || '';
const API_KEY = process.env.LIVE_SEARCH_API_KEY || '';
const ENGINE_ID = process.env.LIVE_SEARCH_ENGINE_ID || '';
const CONFIGURED = !!(API_KEY && ENGINE_ID);

const app = express();
app.use(express.json({ limit: '20kb' }));

// ---- CORS: alleen de eigen WATCHDOG-frontend mag deze backend aanroepen ----
app.use(cors({
  origin: ORIGIN ? [ORIGIN] : false,
  methods: ['GET', 'POST'],
}));

// ---- eenvoudige rate limit per IP (voorkomt misbruik zonder extra dependency) ----
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const w = hits.get(ip) || [];
  const recent = w.filter(t => now - t < 60000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 30; // max 30 requests/minuut/IP
}

// ---- /api/health — GEEFT NOOIT SECRETS TERUG ----
app.get('/api/health', (req, res) => {
  res.json({
    backend: 'online',
    liveSearch: CONFIGURED ? 'configured' : 'not-configured',
    version: 'RC6',
    time: new Date().toISOString(),
  });
});

// ---- /api/search — proxy naar Google Programmable Search Engine (Custom Search JSON API) ----
app.post('/api/search', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ ok: false, error: 'te veel aanvragen, probeer het over een minuut opnieuw' });
  }
  const query = String((req.body && req.body.query) || '').trim();
  if (!query || query.length > 300) {
    return res.status(400).json({ ok: false, error: 'ongeldige zoekopdracht' });
  }
  if (!CONFIGURED) {
    // Eerlijk: geen sleutel ingesteld → geen fake resultaten, geen gesimuleerde 'live' status.
    return res.json({
      ok: false,
      isLive: false,
      source: 'Live Search',
      sourceType: 'not-configured',
      fetchedAt: new Date().toISOString(),
      results: [],
      error: 'Live Search is nog niet geconfigureerd op deze backend (geen API-sleutel ingesteld).',
    });
  }

  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', API_KEY);
  url.searchParams.set('cx', ENGINE_ID);
  url.searchParams.set('q', query);
  url.searchParams.set('num', '10');

  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(url.toString(), { signal: ctl.signal });
    clearTimeout(timeout);
    if (!r.ok) {
      // Nooit de ruwe upstream-foutmelding (kan details lekken) of een stack trace doorgeven.
      return res.status(502).json({ ok: false, error: 'de externe zoekbron gaf een fout terug (HTTP ' + r.status + ')' });
    }
    const data = await r.json();
    const items = Array.isArray(data.items) ? data.items : [];
    const results = items.map(it => ({
      title: it.title || '',
      url: it.link || '',
      snippet: it.snippet || '',
      image: (it.pagemap && it.pagemap.cse_image && it.pagemap.cse_image[0] && it.pagemap.cse_image[0].src) || null,
      source: it.displayLink || null,
    }));
    return res.json({
      ok: true,
      isLive: true,
      source: 'Google Programmable Search Engine',
      sourceType: 'live-search',
      fetchedAt: new Date().toISOString(),
      results,
    });
  } catch (e) {
    clearTimeout(timeout);
    const timedOut = e && e.name === 'AbortError';
    return res.status(504).json({ ok: false, error: timedOut ? 'de zoekopdracht duurde te lang (timeout)' : 'netwerkfout bij het ophalen van live resultaten' });
  }
});

// ---- nette 404 en generieke foutafhandeling, nooit een stack trace naar de gebruiker ----
app.use((req, res) => res.status(404).json({ ok: false, error: 'onbekende route' }));
app.use((err, req, res, next) => {
  console.error('WATCHDOG backend error:', err && err.message);
  res.status(500).json({ ok: false, error: 'interne serverfout' });
});

app.listen(PORT, () => {
  console.log(`WATCHDOG backend luistert op poort ${PORT} — Live Search: ${CONFIGURED ? 'configured' : 'NOT CONFIGURED'}`);
});

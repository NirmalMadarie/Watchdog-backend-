# WAT IK BIJ GOOGLE MOET DOEN — Live Search-sleutel aanmaken

Dit is de enige stap die alleen jij persoonlijk kunt doen (je eigen account, geen programmeerkennis nodig).
Zonder deze twee waarden blijft Live Search eerlijk "niet geconfigureerd" — de rest van WATCHDOG blijft
gewoon werken.

Je hebt hierna **twee waarden** nodig: een **API-sleutel** en een **Zoekmachine-ID** ("cx").

## Deel 1 — de zoekmachine (Programmable Search Engine)
1. Open in je browser: **https://programmablesearchengine.google.com/**
2. Log in met je gewone Google-account.
3. Klik op **"Add"** / **"Nieuwe zoekmachine toevoegen"**.
4. Kies bij "Wat te doorzoeken": **"Search the entire web"** (het hele internet doorzoeken) — niet één specifieke site.
5. Geef de zoekmachine een naam, bijvoorbeeld "WATCHDOG Live Search".
6. Klik op **"Create"** / **"Maken"**.
7. Je ziet nu een pagina met daarop een **Search engine ID**. Dit is een reeks letters/cijfers. **Kopieer deze — dit is je `LIVE_SEARCH_ENGINE_ID`.**

## Deel 2 — de API-sleutel
1. Open: **https://console.cloud.google.com/apis/credentials**
2. Log in met hetzelfde Google-account.
3. Als het vraagt om een project te kiezen/maken: maak een nieuw project, bijvoorbeeld genaamd "watchdog".
4. Zoek in de bibliotheek naar **"Custom Search API"** en klik op **"Enable"** (inschakelen).
5. Ga terug naar **"Credentials"** (Referenties) en klik op **"+ Create credentials" → "API key"**.
6. Er verschijnt een lange reeks tekens. **Kopieer deze — dit is je `LIVE_SEARCH_API_KEY`.**
7. Klik daarna op de sleutel en, onder "API restrictions", zet die vast op **"Custom Search API"** alleen — dit voorkomt misbruik als de sleutel ooit toch zou uitlekken.

## Waar de sleutel VEILIG moet worden opgeslagen
- Alleen als environment variable in je backend-hosting (bijv. Render.com → jouw service → "Environment").
- Naam: `LIVE_SEARCH_API_KEY` en `LIVE_SEARCH_ENGINE_ID` (exact deze namen, zie `.env.example`).

## Waar hij absoluut NIET geplakt mag worden
- **Nooit** in `index.html` of een ander frontendbestand.
- **Nooit** in een commit naar GitHub (ook niet in een "tijdelijk" bestand).
- **Nooit** in een chatbericht, screenshot dat je deelt, of publieke plek.

## Daarna: backend (her)starten en testen
1. Zet de twee waarden bij je backend-hosting onder "Environment Variables" (zie `GITHUB_INSTRUCTIES.md`, stap over Render).
2. Herstart ("redeploy") de backend.
3. Open in je browser: `https://JOUW-BACKEND-URL/api/health` — daar moet nu staan: `"liveSearch":"configured"`.
4. Open WATCHDOG en zoek iets dat niet in de demo staat (bijv. "zoek een zwarte herenjas maat L onder €150"). Nu pas mag je dit als **LIVE** beschouwen.

**Belangrijk:** ik (Claude) heb geen toegang tot jouw Google-account en kan deze stappen niet voor je uitvoeren.
Zolang je dit niet hebt gedaan, blijft Live Search eerlijk "niet geconfigureerd" — WATCHDOG verzint in de
tussentijd geen resultaten.

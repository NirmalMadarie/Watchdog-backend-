# WAT IK NU IN GITHUB MOET DOEN

Deze stappen kun je vanaf je iPhone (github.com in Safari) of een gewone browser doen. Je hoeft niets te
programmeren.

## Deel A — de WATCHDOG-app zelf (frontend, ongewijzigd proces)
1. Ga naar je bestaande GitHub-repository (dezelfde waar je huidige WATCHDOG al in staat).
2. Zoek het bestand dat nu je live site is — meestal **`index.html`** in de hoofdmap (root).
3. **Belangrijk:** laat je oude bestanden gewoon staan. Verwijder niets. Je vervangt alleen de inhoud van `index.html`.
4. Klik op `index.html` → klik op het potlood-icoon ("Edit this file").
5. Verwijder de hele inhoud en plak de volledige inhoud van het nieuwe bestand **`WATCHDOG-RC6.html`** dat ik heb opgeleverd.
6. Scroll naar beneden, klik **"Commit changes"** (opslaan). Dat is je enige commit voor de frontend.
7. GitHub Pages blijft precies zo ingesteld als eerder (Settings → Pages → Branch: main, map: / (root) of /docs, wat je al had). **Je hoeft hier niets aan te veranderen.**
8. **GitHub Pages host alleen de frontend** (de zichtbare app). Het rekenwerk voor Live Search gebeurt straks op een aparte plek (zie Deel B) — niet op GitHub Pages, want die kan geen geheime sleutels bewaren.

## Deel B — de backend (alleen nodig voor Live Search; de rest van WATCHDOG werkt zonder dit)
Ik raad **Render.com** aan: gratis te starten, geen creditcard nodig, werkt rechtstreeks vanuit GitHub.

1. Maak, als je die nog niet hebt, een **tweede, aparte** GitHub-repository, bijvoorbeeld genaamd `watchdog-backend`.
2. Upload daarin de map **`backend/`** die ik heb opgeleverd (met `server.js`, `package.json`, `.env.example`, dit README). Sleep de bestanden op GitHub.com naar "Add file → Upload files".
3. Klik "Commit changes".
4. Ga naar **https://render.com** en maak een gratis account (kan met je GitHub-account inloggen — "Sign in with GitHub").
5. Klik **"New +" → "Web Service"**.
6. Kies de repository `watchdog-backend` die je net hebt aangemaakt.
7. Vul in:
   - **Name:** watchdog-backend (of wat je wilt)
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
8. Klik op **"Advanced"** → **"Add Environment Variable"** en voeg toe:
   - `WATCHDOG_ORIGIN` = de URL van je GitHub Pages-site (bijv. `https://jouwnaam.github.io`)
   - `LIVE_SEARCH_API_KEY` = *(pas invullen nadat je `LIVE_SETUP.md` hebt gevolgd — mag ook later)*
   - `LIVE_SEARCH_ENGINE_ID` = *(idem)*
   - **Plak nooit een sleutel in index.html of in de repository zelf — alleen hier, bij Environment Variables.**
9. Klik **"Create Web Service"**. Render bouwt en start de backend automatisch. Dit duurt een paar minuten.
10. Als het klaar is, zie je bovenaan een URL zoals `https://watchdog-backend-xxxx.onrender.com`. **Dit is je backend-URL.**

## Hoe de frontend de backend-URL krijgt
1. Ga terug naar je **frontend**-repository (Deel A), open `index.html` opnieuw voor bewerking.
2. Zoek (gebruik de zoekfunctie van GitHub's editor) naar de tekst: `WATCHDOG_BACKEND_URL`
3. Vul daar je eigen backend-URL uit stap 10 hierboven in (bijvoorbeeld `https://watchdog-backend-xxxx.onrender.com`), tussen de aanhalingstekens.
4. Commit changes.
5. Live Search gaat nu, zodra je ook `LIVE_SETUP.md` hebt gevolgd, echt werken. Zonder die stap blijft het eerlijk "niet geconfigureerd" — de rest van WATCHDOG blijft gewoon werken.

## Hoe ik deployment controleer
1. Open `https://JOUW-BACKEND-URL/api/health` in je browser. Je moet iets zien als:
   `{"backend":"online","liveSearch":"not-configured","version":"RC6",...}`
   (dat "not-configured" wordt vanzelf "configured" zodra je de sleutel hebt toegevoegd, zie `LIVE_SETUP.md`.)
2. Open je live WATCHDOG-site. Ga naar Instellingen → daar zie je nu ook de Live Search-status.
3. Typ in het AI-scherm bijvoorbeeld **"zoek adres Damrak 1 Amsterdam"** — dit werkt altijd, zonder backend, via PDOK.
4. Typ **"kenteken 33TNS1"** — werkt ook altijd, zonder backend, via RDW.

# WATCHDOG backend (RC6)

Deze kleine server doet precies één ding: hij houdt je geheime Live Search-sleutel veilig op de server en
geeft de frontend (die op GitHub Pages draait) een veilige, sleutelloze manier om live te zoeken.

**Zonder deze backend werkt de rest van WATCHDOG gewoon** (Home, Zoeken/AI met demo-productdata, Mijn geld,
Watches, regelingen, PDOK-adreszoeken, RDW-kentekenzoeken — die laatste twee hebben *geen* backend nodig, zie
hoofdrapport). Alleen "Live Search" (het écht op internet zoeken naar een product of vakantie die niet in de
demo-catalogus staat) heeft deze backend nodig.

## Lokaal testen
```
npm install
cp .env.example .env
# vul .env in (zie LIVE_SETUP.md voor hoe je aan een sleutel komt)
npm start
```
Test daarna:
```
curl http://localhost:8787/api/health
```

## Live zetten (aanbevolen: Render.com — gratis, geen creditcard nodig, werkt via GitHub)
Zie `GITHUB_INSTRUCTIES.md` voor de volledige, genummerde stappen — inclusief hoe je deze backend-map
apart op Render zet en hoe de frontend de backend-URL te weten komt.

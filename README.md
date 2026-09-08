# Puchate Café

Oryginalna, przeglądarkowa gra karciana o prowadzeniu kawiarni dla zwierzaków. Mechanicznie korzysta z jednoczesnego draftu i kolekcjonowania zestawów, ale ma własne nazwy, ilustracje, interfejs i oprawę.

## Co działa

- klasyczna talia 108 kart dla 2–5 graczy oraz wariant Przyjęcie dla 2–8 graczy,
- cztery gotowe menu Przyjęcia, każde z 69 aktywnymi kartami,
- lokalna gra z botami na poziomie łatwym lub normalnym,
- jednoczesny wybór kart, przekazywanie rąk i automatyczna punktacja,
- komplet mechanicznych odpowiedników kart z *Sushi Go!* i *Sushi Go Party!*,
- prywatny multiplayer host-authoritative przez wspólny `qqnd-game-server`,
- wspólne sesje, pokoje, reconnect i routing akcji pod `api.qqnd.fyi`,
- responsywny stół, obsługa dotyku, ograniczenie animacji i czytelność bez polegania wyłącznie na kolorze,
- animowane rozdawanie, odkrywanie i podsumowania oraz proceduralne efekty dźwiękowe z wyciszeniem,
- 27 oryginalnych ilustracji kart w miękkim, trójwymiarowym stylu — bez cudzych grafik.

## Uruchomienie lokalne

Wymagany jest Node.js 20 lub nowszy. Projekt nie ma zależności produkcyjnych.

```bash
npm run dev
```

Następnie otwórz `http://localhost:4173`.

```bash
npm test
npm run check
npm run build
```

## Multiplayer

Gra lokalna nadal działa całkowicie offline. Po otwarciu multiplayera klient łączy się przez WebSocket ze wspólnym backendem QQND:

```text
wss://api.qqnd.fyi/api/v1/ws
```

Nie ma osobnego Cloudflare Workera, SDP/ICE ani połączeń WebRTC pomiędzy graczami. Host tworzy prywatny pokój z kodem `XXXX-XXXX`, a pozostali gracze dołączają przez `qqnd-game-server`.

Na obecnym etapie backend odpowiada za sesje, lobby, numerację miejsc, routing akcji, reconnect i snapshoty. Host przeglądarkowy nadal wykonuje reguły gry i posiada pełny stan; po każdej zmianie zapisuje pełny snapshot na serwerze i publikuje osobny `getPlayerView(state, seat)` dla każdego gościa. Dzięki temu inni gracze nie otrzymują cudzych rąk, kolejności talii, seeda ani RNG.

Szczegóły wdrożenia i modelu migracji znajdują się w [DEPLOY_MULTIPLAYER.md](DEPLOY_MULTIPLAYER.md). Backend jest rozwijany w `quendae/qqnd-game-server` pod Game ID `puchate`.

## Architektura

```text
src/core.js         czysty, deterministyczny silnik zasad
src/party.js        menu, katalog i punktacja wariantu Przyjęcie
src/bots.js         decyzje botów przez ten sam interfejs akcji
src/app.js          kontroler ekranów i sesji
src/ui.js           bezpieczne renderowanie komponentów DOM
src/sound.js        proceduralne efekty Web Audio
src/art.js          mapa oryginalnych ilustracji rastrowych kart
assets/cards/       zoptymalizowane ilustracje WebP
src/multiplayer.js  klient wspólnego qqnd-game-server
tests/              testy reguł, prywatności i protokołu
```

Najważniejsza zasada sieciowa: **jedna autorytatywna symulacja, wiele prywatnych widoków**.

## Zasady w skrócie

W każdej turze wszyscy wybierają kartę zakrytą. Po zatwierdzeniu przez cały stół karty są odkrywane jednocześnie, a pozostałe ręce przechodzą w lewo. Po rundzie punktowane są pary ciasteczek, trójki zestawów, kolekcje bułeczek, goście i popularność napojów. Zwierzaki do adopcji punktują dopiero po trzeciej rundzie.

W wariancie Przyjęcie liczba kart na ręce wynosi 10 / 10 / 9 / 9 / 8 / 8 / 7 dla 2–8 graczy. Desery dochodzą do talii przed każdą rundą, a menu respektują ograniczenia kart przeznaczonych tylko dla 2–6 lub 3–8 osób. Implementację porównano z [oficjalną instrukcją Sushi Go Party!](https://gamewright.com/pdfs/Rules/SushiGoPartyTM-RULES.pdf) i [kartą produktu Gamewright](https://gamewright.com/product/Sushi-Go-Party).

### Mechaniczne odpowiedniki kart klasycznych

| Puchate Café | Liczba | Punktacja / działanie |
|---|---:|---|
| Ciasteczka | 14 | każde 2 = 5 pkt |
| Podwieczorek | 14 | każde 3 = 10 pkt |
| Bułeczki | 14 | 1/2/3/4/5+ kart = 1/3/6/10/15 pkt |
| Kakao ×1 / ×2 / ×3 | 6 / 12 / 8 | najwięcej kubków = 6 pkt, drugie miejsce = 3 pkt |
| Króliczek / Kotek / Piesek | 5 / 10 / 5 | odpowiednio 1 / 2 / 3 pkt |
| Adopcja | 10 | na końcu: najwięcej +6, najmniej −6; rozstrzyga remis |
| Kremowa polewa | 6 | następny gość ma wartość ×3 |
| Dodatkowe łapki | 4 | w późniejszej turze wybierz 2 karty |

### Odpowiedniki kart Przyjęcia 1:1

| Puchate Café | Odpowiednik mechaniczny | Czytelny skrót na karcie |
|---|---|---|
| Kakao | Maki Roll | 1. = 6, 2. = 3 pkt |
| Rożek waflowy | Temaki | najwięcej +4, najmniej −4 |
| Taca ekspresowa | Uramaki | wyścig do 10; 8 / 5 / 2 pkt |
| Ciasteczka | Tempura | ×2 = 5 pkt |
| Podwieczorek | Sashimi | ×3 = 10 pkt |
| Bułeczki | Dumpling | 1–5+ = 1 / 3 / 6 / 10 / 15 pkt |
| Karmelki | Eel | 1 = −3, 2+ = 7 pkt |
| Serniczki | Tofu | 1 / 2 / 3+ = 2 / 6 / 0 pkt |
| Kanapki w 4 kształtach | Onigiri | 1 / 2 / 3 / 4 różne = 1 / 4 / 9 / 16 pkt |
| Wspólna posypka | Edamame | +1 za rywala z posypką, maks. 4 na kartę |
| Zupa dnia | Miso Soup | 3 pkt, ale zderzenie w tej samej turze odrzuca zupy |
| Kremowa polewa | Wasabi | następny gość ×3 |
| Dodatkowe łapki | Chopsticks | później wybierz 2 karty |
| Stały gość | Soy Sauce | 4 pkt za kartę przy największej różnorodności |
| Dzbanek herbaty | Tea | każda karta = wielkość największego zestawu |
| Menu dnia | Menu | dobierz 4, wybierz 1 |
| Srebrna łyżeczka | Spoon | poproś o typ i wymień kartę |
| Specjalne zamówienie | Special Order | kopiuje wcześniej zagraną kartę |
| Pudełko na wynos | Takeout Box | odwrócone karty po 2 pkt |
| Króliczek / Kotek / Piesek | Egg / Salmon / Squid Nigiri | 1 / 2 / 3 pkt |
| Adopcja | Pudding | na końcu najwięcej +6, najmniej −6 |
| Tort lodowy | Green Tea Ice Cream | ×4 = 12 pkt na końcu |
| Owocowy koszyk | Fruit | każdy owoc: 0–5+ = −2 / 0 / 1 / 3 / 6 / 10 pkt |

## Licencja i grafiki

Kod jest dostępny na licencji MIT. Nazwa „Puchate Café”, teksty i ilustracje w tym repozytorium są oryginalne i nie są oficjalnie związane z *Sushi Go!* ani jego wydawcą. Zapis promptów użytych do przygotowania nowych ilustracji znajduje się w [PARTY_ART_PROMPTS.md](PARTY_ART_PROMPTS.md).

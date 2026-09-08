# Wdrożenie multiplayera Puchate Café

Puchate Café używa tego samego modelu wdrożeniowego co SKAT: strona gry i mały Worker sygnalizacyjny są wdrażane oddzielnie, ale dla gracza działają pod jedną domeną.

| Element | Gdzie trafia |
| --- | --- |
| aplikacja Puchate Café | serwer WWW obsługujący `puchate.qqnd.fyi` |
| `worker/` | Cloudflare Workers + Durable Object |
| `/api/*` | trasa kierowana przez Cloudflare do Workera |

Worker **nie jest serwerem gry**. Przechowuje jedynie krótkotrwały pokój i przekazuje SDP/ICE potrzebne do zestawienia WebRTC. Po otwarciu DataChannel rozgrywka jest P2P, a host jest jedynym właścicielem pełnego stanu gry.

## 1. Wymagania

- domena `qqnd.fyi` w Cloudflare,
- `puchate.qqnd.fyi` wystawione przez HTTPS,
- rekord DNS domeny proxied przez Cloudflare,
- Node.js 20+ i npm na komputerze używanym do wdrożenia Workera.

## 2. Deploy Workera

```bash
cd worker
npm install
npx wrangler login
npm run deploy
```

`wrangler.toml` przypisuje Worker do:

```text
puchate.qqnd.fyi/api/*
```

Strona główna i zwykłe assety nadal trafiają do serwera WWW. Tylko `/api/*` obsługuje Cloudflare Worker.

## 3. Test po wdrożeniu

Otwórz:

```text
https://puchate.qqnd.fyi/api/health
```

Poprawna odpowiedź:

```json
{"ok":true,"service":"puchate-cafe-signaling","maxGuests":7}
```

Następnie:

1. otwórz grę w dwóch niezależnych przeglądarkach lub urządzeniach,
2. na pierwszym urządzeniu wybierz **Multiplayer → Załóż stolik**,
3. na drugim wybierz **Dołącz** i wpisz sześcioliterowy kod,
4. sprawdź synchronizację lobby,
5. rozpocznij grę i wykonaj przynajmniej pełną rundę,
6. na jednym urządzeniu zamknij kartę podczas gry — pozostała sesja powinna zostać zatrzymana, a kolejne akcje odrzucone.

## 4. Adres sygnalizacji w kliencie

Domyślna konfiguracja klienta używa względnego adresu:

```text
/api
```

czyli na produkcji automatycznie łączy się z `wss://puchate.qqnd.fyi/api/...`. Użytkownik nie musi wpisywać osobnego adresu serwera, tak jak w działającym wdrożeniu SKAT.

Pole **Ustawienia połączenia** nadal pozwala nadpisać adres. Jest przydatne podczas lokalnego developmentu lub testu Workera na `*.workers.dev`.

## 5. Model bezpieczeństwa i autorytetu

- host utrzymuje pełny `GameState`, seed, RNG i kolejność talii,
- gość wysyła wyłącznie `action`/intencję,
- host wykonuje akcję tym samym dispatcherem co gra lokalna,
- host po zmianie stanu wysyła osobny `getPlayerView(state, seat)` do każdego gracza,
- ręka przeciwnika, talia, RNG oraz cudze zakryte wybory nie są serializowane do jego widoku,
- boty działają wyłącznie po stronie hosta i korzystają z tego samego API akcji,
- miejsce bota jest zarezerwowane i nie może zostać zajęte przez gościa,
- po utracie człowieka w trakcie gry host pauzuje autorytet i blokuje dalsze akcje.

To jest model do prywatnych gier znajomych. Host technicznie może podejrzeć własny pełny stan w narzędziach deweloperskich.

## 6. NAT / TURN

Domyślnie WebRTC używa publicznego STUN. W restrykcyjnych sieciach (część sieci komórkowych, firmowych i CGNAT) bezpośrednie zestawienie P2P może się nie udać. W takim przypadku należy dodać własny TURN do `rtcConfig` klienta. TURN przekazuje zaszyfrowany ruch WebRTC; nie zmienia modelu host-authoritative.

## 7. Aktualizacje

Zmiany wyłącznie w wyglądzie lub zasadach gry nie wymagają redeployu Workera. Po zmianie `worker/src/index.js` albo `worker/wrangler.toml` wykonaj ponownie:

```bash
cd worker
npm run deploy
```

Po deployu zawsze sprawdź `/api/health` i utwórz nowy pokój testowy.

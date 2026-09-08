# Multiplayer Puchate Café — wspólny serwer QQND

Puchate Café **nie ma własnego Workera, serwera sygnalizacyjnego ani WebRTC**. Multiplayer korzysta ze wspólnego backendu `quendae/qqnd-game-server`, tak jak pozostałe migrowane gry QQND.

## Architektura

```text
puchate.qqnd.fyi
      │
      │ WebSocket
      ▼
wss://api.qqnd.fyi/api/v1/ws
      │
      ▼
qqnd-game-server
```

Wspólny serwer odpowiada za:

- sesje gości i tokeny wznowienia,
- tworzenie i dołączanie do prywatnych pokoi,
- ośmioznakowe kody pokoi w formacie `XXXX-XXXX`,
- kolejność i routing akcji,
- obecność graczy,
- reconnect i zachowanie numeru miejsca,
- przechowanie pełnego snapshotu hosta oraz prywatnych widoków gości,
- przekazanie hosta po dłuższej utracie połączenia.

Puchate Café jest na etapie bridge/Phase 1: zasady i losowanie nadal wykonuje autorytatywny klient-host. Goście wysyłają `game.action` do `qqnd-game-server`; serwer przekazuje akcję aktualnemu hostowi. Host zatwierdza zmianę, zapisuje pełny stan przez `game.state.commit` i publikuje osobny `getPlayerView(state, seat)` przez `game.state.publish` dla każdego człowieka.

Dzięki temu z klienta usunięto cały stary tor SDP/ICE/DataChannel, ale nie trzeba jeszcze przepisywać dużego silnika Puchate Café na TypeScript po stronie backendu.

## Backend

Obsługa gry znajduje się w repozytorium:

```text
quendae/qqnd-game-server
```

Game ID:

```text
puchate
```

Zakres graczy: **2–8**. Matchmaking jest na razie wyłączony; używane są prywatne pokoje.

Backend musi być wdrożony zgodnie z instrukcjami w repo `qqnd-game-server` i dostępny pod:

```text
https://api.qqnd.fyi
wss://api.qqnd.fyi/api/v1/ws
```

Nie wdrażaj niczego z repo Puchate Café do Cloudflare Workers.

## Frontend

Frontend Puchate Café wymaga tylko zwykłego wdrożenia statycznej aplikacji na `puchate.qqnd.fyi`. Domyślnie łączy się z:

```text
wss://api.qqnd.fyi/api/v1/ws
```

Adres można nadpisać w ustawieniach połączenia do lokalnych testów, np.:

```text
ws://127.0.0.1:3000/api/v1/ws
```

## Test ręczny

1. Otwórz `https://puchate.qqnd.fyi` w dwóch niezależnych przeglądarkach lub urządzeniach.
2. Na pierwszym urządzeniu wybierz **Multiplayer → Załóż stolik**.
3. Skopiuj kod w formacie `XXXX-XXXX`.
4. Na drugim urządzeniu wybierz **Dołącz** i wpisz kod.
5. Sprawdź, czy oba klienty widzą tę samą listę graczy.
6. Host może uzupełnić wolne miejsca botami i rozpocząć grę.
7. Rozegraj pełną rundę i potwierdź, że gość widzi tylko własną rękę.
8. Rozłącz jednego gracza i sprawdź komunikat reconnect; po wznowieniu sesji powinien odzyskać to samo miejsce i prywatny snapshot.

## Prywatność stanu

Pełny stan zawierający talię, RNG, seed i wszystkie ręce jest dostępny tylko bieżącemu hostowi oraz przechowywany przez backend jako snapshot potrzebny do reconnect/zmiany hosta. Do innych klientów wysyłany jest wyłącznie widok wygenerowany przez `getPlayerView(state, seat)`.

To nadal model host-authoritative do prywatnych gier. Docelowym kolejnym etapem, jeśli Puchate Café ma obsługiwać ranking lub niezaufane lobby publiczne, jest przeniesienie reduktora zasad do `qqnd-game-server`, analogicznie do aktualnego serwerowego silnika SKAT/Tichu.

# Data safety and app content

Answers for Play Console's App content pages, and the facts behind them. Revisit them if the game ever adds
accounts, analytics, ads or a server of its own.

## What the app does with data

| | |
| --- | --- |
| Accounts | none |
| Ads, analytics, crash reporting, purchases | none (no SDKs at all: Java and a WebView) |
| Permissions | `INTERNET` only (network games) |
| Stored on the device | settings, controls, last line-ups, player name, arena lists, schemes (WebView storage); no Android backup (`allowBackup=false`, `data_extraction_rules.xml`) |
| Local games | nothing leaves the device |
| Network games: handshake | through public MQTT brokers (EMQX, HiveMQ, Mosquitto) over TLS, encrypted end to end (AES-GCM, key from the room code); brokers keep nothing |
| Network games: finding games on the same network | a host announces its game (host's player name, room code, players, arena) on a broker channel derived from the network's public IP address |
| Network games: playing | player names, looks, chat messages and moves go peer to peer (WebRTC, encrypted) to the other players only; public STUN servers (Cloudflare, Google) tell a device its public address |
| The developer | receives nothing |

## Data safety form

The same answers as Pong Wars Reloaded:

- **Does your app collect or share any of the required user data types?** No. The developer receives nothing
  and there are no SDKs; what network games send goes from player to player (the handshake through the
  relays encrypted end to end), at the players' request.
- **Account creation:** none.

## Other declarations

| Declaration | Answer |
| --- | --- |
| Privacy policy | https://mayerwin.github.io/Boom-Buds/privacy.html |
| Ads | No |
| Advertising ID | No |
| App access | All functionality available without special access |
| Content rating (IARC) | Submitted: fantastical, pixelated, unrealistic violence against human-like characters seen from a distance, no blood; flatulence sounds; users interact (chat, not moderated, limited to people with the room code); no purchases, gambling, drugs or bad language. Result: ESRB Everyone 10+, PEGI 7, USK 12, ClassInd L, ACB PG |
| Target audience | 13–15, 16–17, 18+ (the chat with other players makes the app unsuitable for a younger audience) |
| News, government, financial, health | No |
| Countries | all |

# Knowledge card: mobile

Wat bij mobiele missies aantoonbaar vaak vergeten wordt.

## Netwerk-realiteit
- Offline/slow-network-gedrag ontworpen, niet ontdekt: cache-strategie, wachtrij voor mutaties,
  duidelijke offline-staat in de UI.
- Elke fetch heeft timeout + foutstaat; een spinner zonder einde is een bug.

## App-lifecycle
- Background/kill/resume getest: state overleeft een kill of herstelt eerlijk (geen halve formulieren
  kwijt zonder melding).
- Deep links werken vanuit koude start én warme app.

## Opslag & veiligheid
- Tokens in secure storage (Keychain/Keystore), nooit in plain AsyncStorage/SharedPreferences.
- Gevoelige schermen: geen inhoud in de app-switcher-snapshot waar dat schaadt.

## Platform
- Beide platforms (of expliciet één, met reden); echte apparaat-/simulatorcontrole, niet alleen web-preview.
- Store-eisen vroeg gecheckt (permissies met redenen, privacy-labels) — een afwijzing laat op de
  planning is duur.

## Bewijsvorm
- Offline-test (vliegtuigmodus-scenario) · lifecycle-test (kill/resume) · deep-link-test ·
  secure-storage-verificatie · store-checklist doorlopen.

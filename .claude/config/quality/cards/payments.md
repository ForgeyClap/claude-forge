# Knowledge card: payments

Wat bij betaalmissies aantoonbaar vaak vergeten wordt. Geld verdraagt geen "meestal goed".

## Geldhygiëne
- Bedragen in centen (integers) — nooit floats voor geld.
- Idempotency keys op ELKE geldmutatie (charge, refund, payout) — een retry mag nooit dubbel afschrijven.
- Nooit kaartdata aanraken: tokenization via de PSP (Stripe/Mollie/Adyen); PCI-scope minimaal houden.

## Webhooks van de PSP
- Signatuurverificatie verplicht (en getest met een NEGATIEVE test: fout signatuur → geweigerd).
- Out-of-order en duplicate events verwerken; de webhook is de waarheid, niet de redirect.

## De vergeten paden
- Refund-pad end-to-end getest — niet alleen de happy flow van betalen.
- Reconciliatie: wat als de webhook NOOIT komt? (polling-fallback of dagelijkse afstemming.)
- Gedeeltelijke betalingen/chargebacks benoemd: ondersteund of expliciet buiten scope.

## Owner-gates
- Live keys, echte transacties, uitbetalingen: altijd expliciete owner-goedkeuring; testmode tot die tijd.

## Bewijsvorm
- Dubbele-submit-test op checkout (één charge) · signatuur-negatieftest · refund-e2e in testmode ·
  reconciliatie-scenario gedocumenteerd.

# Destroying Desmond — white-label 4flieks site

A single-film site running on the existing `flieks-app` Firebase project. Nothing here touches
`index.html`, `filmmaker.html`, `admin.html` or the live `payfast-itn` function.

```
index.html                        the film page
attribution.html                  per-actor performance dashboard (admin only)
dd-seed.json                      Firebase import: film config + cast
firebase-rules-additions.json     rules to merge into the existing rules
netlify/functions/
  dd-checkout.js                  signs the PayFast payload
  dd-itn.js                       PayFast webhook — grants access, mints gift codes
  dd-redeem.js                    claims a gift code
  dd-stream.js                    releases the video URL only to paying accounts
```

## Deploy

This is a **separate Netlify site** from 4flieks, connected to its own GitHub repo (or a
subfolder of `flieks-app` with the base directory set). It needs the GitHub connection —
the functions can't go out by drag-and-drop.

1. **Netlify env vars** — same values as the 4flieks site, plus one new one:

   | Var | Note |
   |---|---|
   | `PAYFAST_MERCHANT_ID` | |
   | `PAYFAST_MERCHANT_KEY` | |
   | `PAYFAST_PASSPHRASE` | must match the passphrase set in the PayFast dashboard |
   | `PAYFAST_SANDBOX` | `true` for now |
   | `FIREBASE_DB_URL` | `https://flieks-app-default-rtdb.firebaseio.com` |
   | `FIREBASE_DB_SECRET` | |
   | **`FIREBASE_API_KEY`** | **new** — the web API key, used to verify ID tokens server-side |

2. **Firebase config** — three placeholders in both `index.html` and `attribution.html`
   say `PASTE_FROM_4FLIEKS_INDEX`. Copy `apiKey`, `messagingSenderId` and `appId` across
   from your existing `index.html`.

3. **Import `dd-seed.json`** at the database root (Firebase console → Realtime Database →
   ⋮ → Import JSON). Importing at the root **replaces everything**, so import each top-level
   node separately instead — navigate to the empty node and import the inner object. Fill in
   the real poster, trailer, cast and prices as you go.

4. **Merge the rules.** Open `firebase-rules-additions.json`, copy each key into your existing
   rules object, publish. Don't paste the whole file over the top — it would wipe the
   `flieks_*` rules.

5. **PayFast dashboard** — add the new site's domain to the allowed return/notify hosts.

## How the money flows

```
follower taps actor's bio link  →  /?a=actor-one
                                   click counted to actor-one, stored 30 days
trailer plays free             →  no account needed
buys                           →  dd-checkout signs the payload → PayFast
PayFast confirms               →  dd-itn writes flieks_purchases/{uid}/destroying-desmond
                                   and credits the sale + revenue to actor-one
plays                          →  dd-stream checks the purchase, then hands over the URL
```

Three tiers: **stream** (48h from first play), **own** (permanent + download),
**gift** (buyer gets a 6-character code, recipient redeems it for a permanent copy).

Gift codes use an alphabet with no `0 O 1 I L`, so they survive being read aloud on a phone call.

## Handing out the actor links

Each cast entry in `dd_cast` has a slug. The link is `https://yourdomain/?a=slug`.
Cast members can grab their own from the Cast section on the page, and you can copy any of
them from `attribution.html`, which also shows clicks, trailer plays, sales, conversion rate
and revenue per person.

That table is the point of the whole build. With 5M combined reach the useful question isn't
"did it work" — it's which two or three of them are actually converting, so you know where
to concentrate the next push and what to pay them.

## Two honest limitations

- **The video URL can be shared.** `dd-stream` keeps it out of the public database and only
  hands it to accounts that have paid, which stops casual URL-sharing and scraping. It is not
  DRM. Anyone determined can pull the file from their browser and pass it on. Real protection
  means HLS with signed segment URLs (Cloudflare Stream, Mux, Bunny) — worth doing if the
  film earns enough to justify it, not worth blocking launch over.
- **Review approval isn't in this build.** Reviews land with `approved: false` and only show
  once flipped to `true`. Do that from the Firebase console for now, or add a tab to
  `admin.html` reading `dd_reviews`.

## Before you go live

- [ ] Fill in `dd_config` — logline, synopsis, credits, real prices
- [ ] Upload poster (9:16), a 16:9 still, trailer, and the feature to Storage
- [ ] Put the feature's URL in `dd_private/destroying-desmond/videoUrl`, **not** in `dd_config`
- [ ] Add every cast member with slug, photo, socials and follower count
- [ ] Test each of the three tiers end to end with card `4111 1111 1111 1111`
- [ ] Buy a gift, redeem the code on a second account
- [ ] Confirm a sale through `?a=slug` shows up in `attribution.html`
- [ ] Flip `PAYFAST_SANDBOX` to `false`
- [ ] Set the OG image so the link previews properly in DMs — this is a link-in-bio product,
      the preview card is doing half the selling

# Outfit Maker

A digital wardrobe that picks your outfit every morning. You photograph your real clothes, the app cuts them out, and then it suggests what to wear. Its choice depends on today's weather, the style you're in the mood for, what you wore recently and what's in the laundry. It also learns from your likes and swaps.

Built from scratch as a learning project: a Node.js/Express backend with SQLite and a vanilla JavaScript PWA. There is no frontend framework and no build step.

![Outfit Maker screens](docs/screens.png)

## Features

- **Digital wardrobe.** Add clothes with the in-app camera, which shows an outline guide for each type of item. The background is removed on the device and the main colour is detected automatically. Clothes without a photo are shown as a drawing of their type, in their colour.
- **Outfit generator.**
  - **Weather:** reads the local forecast and decides warmth and when a jacket is needed.
  - **Style:** you pick Sport, Baggy, Classy or Fit.
  - **Colour:** one strong colour at most, the rest neutral.
  - **Recent wear:** penalises what you wore yesterday.
  - **Laundry:** skips anything marked as in the wash.
- **It learns your taste.** 👍 an outfit and every pair in it scores higher. Swap one piece and the robot remembers that piece didn't fit. Skip a whole outfit and it learns nothing, because the reason is unknown.
- **Accessories.** Head, neck and wrist slots are offered as "Would you also wear…?" suggestions, never forced. No bracelets with Sport, and scarves and beanies only when it's cold.
- **Week planner.** Plan outfits for the next 7 days. On the day, the app warns you if a planned piece is in the laundry and helps you swap it.
- **Wear tracking and weekly stats.** "Wore it today" fills a wear diary. Profile shows days dressed this week, the style you wore most, and forgotten clothes: never worn, or not worn in 30 days.
- **Outfits.** Create your own outfit or save a generated one. Each outfit is shown as a flat lay and can be exported as a 1080×1350 image for Instagram or TikTok.
- **Accounts.** Every user only ever sees their own clothes, outfits and photos.
- **Installable PWA.** Add it to your phone's home screen, and it opens offline.

## Tech

| Part | Used |
|---|---|
| Server | Node.js, Express, REST API |
| Database | SQLite through Node's built-in `node:sqlite`: relational schema, transactions, parameterized queries |
| Frontend | HTML, CSS (custom properties as a small design system), vanilla JavaScript |
| Images | Canvas API, on-device background removal (ONNX/WebAssembly) |
| App | PWA: Web App Manifest, Service Worker |
| Other | Open-Meteo weather API, Geolocation API, Web Share API |

## How it works

**Database.**
- `users` and `sessions` hold the accounts.
- `clothes`, `outfits` and `outfit_items` hold the wardrobe. An outfit stores pointers to clothes, not copies.
- `wears` is the diary of what you wore. Counts are computed with `COUNT`/`MAX` when needed, so they can never be out of date.
- `pair_scores` stores what the robot learned. Each pair is stored once (`item_a < item_b`), and its score is clamped between −5 and +5 with an UPSERT.
- `plan_items` holds the week planner. It points to individual pieces, so changing Thursday's plan never changes a saved outfit.

**Scoring.**
- Each candidate gets points from the rules below; the generator then picks at random among the best candidates, so you still get variety.
  - **Shared style:** +2 with each piece already chosen.
  - **Clashing styles:** −3 (Sport with Classy, Baggy with Fit).
  - **A second strong colour:** −10.
  - **What it learned:** +2 × the pair's score.
  - **Worn yesterday:** −4.

**Security.**
- **Passwords:** hashed with scrypt and a per-user salt, compared in constant time.
- **Sessions:** an `HttpOnly`, `SameSite=Lax` cookie.
- **Ownership:** every query checks `owner_id`.
- **Photos:** stored outside `public/` with random names, served only to their owner.
- **SQL:** user input never goes into SQL text; queries use `?` parameters.

## Run it locally

You need **Node.js 22.13 or newer** (it uses the built-in `node:sqlite`).

```bash
git clone https://github.com/randrei550-commits/outfit-maker.git
cd outfit-maker
npm install
node server.js
```

Open http://localhost:3000 and create an account. The database file `outfit-maker.db` is created on first start. Node prints an `ExperimentalWarning` for SQLite; that's expected.

## What I learned

This was my first full-stack project. I came from C, where I'd only written algorithmic code, so this was my first contact with JavaScript and the web. Along the way I learned:
- how a REST API and a database fit together;
- why passwords are hashed and salted;
- how cookies keep you logged in;
- why `MAX()` returns `NULL` and not `0` for something that never happened;
- why a `.gitignore` only protects files that were never committed.

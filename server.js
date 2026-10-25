const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto"); // built into Node: hashes and random numbers
const { DatabaseSync } = require("node:sqlite"); // NEW: a real database, also built into Node

// secrets (like the AI key) live in a file called .env that git IGNORES,
// so they never end up on GitHub. Node can read that file by itself.
try {
  process.loadEnvFile(); // reads .env into process.env
} catch (error) {
  console.log("No .env file found: the 3D (ghost mannequin) feature will be off.");
}

const app = express();
const PORT = 3000;
const SESSION_DAYS = 30;
// photos live OUTSIDE "public", so express.static can't hand them to just anyone.
// The only way in is the /api/photos route below, which checks your ticket first.
const PHOTO_DIR = "photos";

fs.mkdirSync(PHOTO_DIR, { recursive: true });

app.use(express.static("public"));
app.use(express.json({ limit: "15mb" })); // photos travel as text, so requests can be big

// ---------- Database ----------
// The whole database is ONE file: outfit-maker.db. Inside it there are tables,
// like arrays of structs in C, but the database finds rows for us (fast) and
// never loses a write halfway (safe).

const db = new DatabaseSync("outfit-maker.db");
db.exec("PRAGMA foreign_keys = ON"); // makes the REFERENCES rules below actually work

// CREATE TABLE = declaring a struct. IF NOT EXISTS = only the first time.
// REFERENCES = "this number must be the id of a real row over there" (like a pointer that can't dangle)
// ON DELETE CASCADE = delete a user, and their tickets go too
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY,
    username   TEXT NOT NULL UNIQUE,
    salt       TEXT NOT NULL,
    hash       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token   TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS clothes (
    id        INTEGER PRIMARY KEY,
    owner_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    type      TEXT NOT NULL,
    styles    TEXT NOT NULL DEFAULT '[]',
    warmth    INTEGER NOT NULL DEFAULT 2,
    rainproof INTEGER NOT NULL DEFAULT 0,
    photo     TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS outfits (
    id         INTEGER PRIMARY KEY,
    owner_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    occasion   TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- which clothes are in which outfit: one row per (outfit, item) pair.
  -- Delete a piece of clothing and it disappears from every outfit by itself.
  CREATE TABLE IF NOT EXISTS outfit_items (
    outfit_id INTEGER NOT NULL REFERENCES outfits(id) ON DELETE CASCADE,
    item_id   INTEGER NOT NULL REFERENCES clothes(id) ON DELETE CASCADE,
    PRIMARY KEY (outfit_id, item_id)
  );

  -- an INDEX is like a sorted table of contents: "clothes of user 1" is found
  -- with a binary search instead of a for loop over every row
  CREATE INDEX IF NOT EXISTS clothes_by_owner ON clothes(owner_id);
  CREATE INDEX IF NOT EXISTS outfits_by_owner ON outfits(owner_id);
`);

// NEW in v15: the main colour of each item ("neutral", "blue", ...).
// Old databases don't have this column yet, so we add it once (ALTER TABLE = change the struct)
const COLORS = ["neutral", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"];
const clothesColumns = db.prepare("PRAGMA table_info(clothes)").all().map((c) => c.name);
if (!clothesColumns.includes("color")) {
  db.exec("ALTER TABLE clothes ADD COLUMN color TEXT NOT NULL DEFAULT ''");
}
// NEW in v16: "in the laundry" is a yes/no. SQLite has no bool (like old C), so 0 = no, 1 = yes
if (!clothesColumns.includes("in_laundry")) {
  db.exec("ALTER TABLE clothes ADD COLUMN in_laundry INTEGER NOT NULL DEFAULT 0");
}

// NEW in v16: a diary of what you wore. One row = "I wore item X on day Y".
// We don't store a counter: we COUNT the rows when we need the number, so it can never be wrong.
// UNIQUE = pressing "Wore it" twice on the same day still counts once.
db.exec(`
  CREATE TABLE IF NOT EXISTS wears (
    id      INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES clothes(id) ON DELETE CASCADE,
    worn_on TEXT NOT NULL,
    UNIQUE (item_id, worn_on)
  );
  CREATE INDEX IF NOT EXISTS wears_by_item ON wears(item_id);

  -- NEW in v17: what the robot learned about PAIRS of clothes.
  -- score > 0: "these two go well together", score < 0: "not together".
  -- Always item_a < item_b, so (5, 9) and (9, 5) can't both exist: one pair, one row.
  CREATE TABLE IF NOT EXISTS pair_scores (
    item_a INTEGER NOT NULL REFERENCES clothes(id) ON DELETE CASCADE,
    item_b INTEGER NOT NULL REFERENCES clothes(id) ON DELETE CASCADE,
    score  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (item_a, item_b),
    CHECK (item_a < item_b)
  );
`);

// all-or-nothing: if anything inside fn fails, every change is undone (ROLLBACK)
function transaction(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// a row from the database -> the shape the app already knows
function clothingFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    styles: JSON.parse(row.styles),
    warmth: row.warmth,
    rainproof: row.rainproof === 1,
    photo: row.photo,
    color: row.color,
    inLaundry: row.in_laundry === 1,
    wearCount: row.wear_count || 0,   // how many days you wore it
    lastWorn: row.last_worn || null   // "2026-10-25", or null if never
  };
}

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
}

// one-time move: the old JSON files go into the database, then get renamed
// to .imported (a backup, never read again)
function importOldJsonFiles() {
  const files = ["users.json", "sessions.json", "clothes.json", "outfits.json"];
  if (!files.some((f) => fs.existsSync(f))) return;
  if (db.prepare("SELECT COUNT(*) AS n FROM users").get().n > 0) return; // already imported

  transaction(() => {
    for (const u of readJson("users.json")) {
      db.prepare("INSERT INTO users (id, username, salt, hash, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(u.id, u.username, u.salt, u.hash, u.createdAt);
    }
    for (const s of readJson("sessions.json")) {
      if (s.expires > Date.now()) {
        db.prepare("INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)").run(s.token, s.userId, s.expires);
      }
    }
    for (const c of readJson("clothes.json")) {
      db.prepare("INSERT INTO clothes (id, owner_id, name, type, styles, warmth, rainproof, photo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(c.id, c.ownerId ?? null, c.name, c.type, JSON.stringify(c.styles || []), c.warmth || 2, c.rainproof ? 1 : 0, c.photo || "");
    }
    const itemExists = db.prepare("SELECT 1 FROM clothes WHERE id = ?");
    for (const o of readJson("outfits.json")) {
      db.prepare("INSERT INTO outfits (id, owner_id, name, occasion, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(o.id, o.ownerId ?? null, o.name, o.occasion, o.createdAt);
      for (const itemId of o.itemIds) {
        // old outfits could point at deleted clothes; the database doesn't allow that, so we skip them
        if (itemExists.get(itemId)) {
          db.prepare("INSERT OR IGNORE INTO outfit_items (outfit_id, item_id) VALUES (?, ?)").run(o.id, itemId);
        }
      }
    }
  });

  for (const f of files) {
    if (fs.existsSync(f)) fs.renameSync(f, f + ".imported");
  }
  console.log("Moved your JSON data into outfit-maker.db (old files renamed to .imported).");
}
importOldJsonFiles();

// ---------- Accounts ----------
// Password -> hash: a one-way function, like a fingerprint. From the hash nobody can get
// the password back. The salt is a random string, different for every user, so two
// people with the same password still get different hashes.

function hashPassword(password, salt) {
  // scrypt is slow ON PURPOSE: one try is instant for us, a billion tries is years for a thief
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

// the server reads the cookie header by itself: "sid=abc123; theme=dark" -> { sid: "abc123", theme: "dark" }
function readCookies(req) {
  const cookies = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key) cookies[key] = decodeURIComponent(rest.join("="));
  }
  return cookies;
}

// gives the browser its ticket. HttpOnly = JavaScript in the page can't read it,
// so even a bug in our page can't leak it. SameSite=Lax = other sites can't use it.
function giveTicket(res, userId) {
  const token = crypto.randomBytes(32).toString("hex"); // 64 random characters, impossible to guess
  db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now()); // throw away old tickets
  db.prepare("INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)")
    .run(token, userId, Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  res.setHeader("Set-Cookie", `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`);
}

// who is asking? Returns the user, or null if there is no valid ticket.
// JOIN = glue two tables together: the ticket row + the user row it points at
function currentUser(req) {
  const token = readCookies(req).sid;
  if (!token) return null;
  return db.prepare(`
    SELECT users.* FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ? AND sessions.expires > ?
  `).get(token, Date.now()) || null;
}

// a "guard" that runs BEFORE a route. No ticket = 401 and the route never runs.
// next() means "ok, go on to the real route"
function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Please log in." });
  req.user = user;
  next();
}

// what we send back about a user: NEVER the hash or the salt
function publicUser(user) {
  return { id: user.id, username: user.username };
}

app.post("/api/register", (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!/^[a-z0-9_.]{3,20}$/.test(username)) {
    return res.status(400).json({ error: "Username: 3 to 20 letters, numbers, _ or ." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "The password needs at least 8 characters." });
  }
  if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) {
    return res.status(409).json({ error: "That username is taken." });
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const user = transaction(() => {
    const result = db.prepare("INSERT INTO users (username, salt, hash, created_at) VALUES (?, ?, ?, ?)")
      .run(username, salt, hashPassword(password, salt), new Date().toISOString());
    const id = Number(result.lastInsertRowid); // the id the database just picked for us
    // the very first account adopts the clothes and outfits made before accounts existed
    db.prepare("UPDATE clothes SET owner_id = ? WHERE owner_id IS NULL").run(id);
    db.prepare("UPDATE outfits SET owner_id = ? WHERE owner_id IS NULL").run(id);
    return { id, username };
  });

  giveTicket(res, user.id);
  res.status(201).json(publicUser(user));
});

app.post("/api/login", (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);

  // same salt + same password = same hash. That's the whole check.
  // timingSafeEqual compares in constant time, so a thief can't learn anything from how fast we answer
  const ok = user && crypto.timingSafeEqual(Buffer.from(hashPassword(password, user.salt), "hex"), Buffer.from(user.hash, "hex"));
  if (!ok) {
    // the same message for "no such user" and "wrong password", so nobody can find out who has an account
    return res.status(401).json({ error: "Wrong username or password." });
  }
  giveTicket(res, user.id);
  res.json(publicUser(user));
});

app.post("/api/logout", (req, res) => {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(readCookies(req).sid || ""); // tear up the ticket
  res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.status(204).end();
});

app.get("/api/me", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Please log in." });
  res.json(publicUser(user));
});

// ---------- Photos (private) ----------
// A random name like "9f2c…e1.png" instead of "9.png", so nobody can guess the next one.
function randomPhotoName(extension) {
  return crypto.randomBytes(16).toString("hex") + extension;
}

// one-time move: photos from the old public/uploads go to the private folder, with random names
function movePublicPhotos() {
  const rows = db.prepare("SELECT id, photo FROM clothes WHERE photo LIKE 'uploads/%'").all();
  for (const row of rows) {
    const oldFile = path.join("public", row.photo);
    let photo = ""; // the file was already gone: show the first letter instead
    if (fs.existsSync(oldFile)) {
      const newName = randomPhotoName(path.extname(row.photo));
      fs.renameSync(oldFile, path.join(PHOTO_DIR, newName));
      photo = "api/photos/" + newName;
    }
    db.prepare("UPDATE clothes SET photo = ? WHERE id = ?").run(photo, row.id);
  }
  if (rows.length > 0) console.log("Moved " + rows.length + " photos to the private photos folder.");
}
movePublicPhotos();

// the guard checks the ticket, then we check that the photo belongs to one of YOUR items
app.get("/api/photos/:file", requireUser, (req, res) => {
  const file = path.basename(req.params.file); // basename blocks tricks like "../../server.js"
  const isMine = db.prepare("SELECT 1 FROM clothes WHERE owner_id = ? AND photo = ?").get(req.user.id, "api/photos/" + file);
  if (!isMine) return res.status(404).json({ error: "Photo not found." });
  res.setHeader("Cache-Control", "private, max-age=86400"); // only YOUR browser may keep a copy
  res.sendFile(path.resolve(PHOTO_DIR, file));
});

// ---------- Clothes ----------
// every route below gets requireUser first, and only touches rows WHERE owner_id = you

app.get("/api/clothes", requireUser, (req, res) => {
  // LEFT JOIN = every item, even the ones never worn (they get COUNT 0).
  // GROUP BY = one result row per item, with the count of its rows in wears:
  // this is your "frequency vector", calculated by the database
  const rows = db.prepare(`
    SELECT clothes.*, COUNT(wears.id) AS wear_count, MAX(wears.worn_on) AS last_worn
    FROM clothes
    LEFT JOIN wears ON wears.item_id = clothes.id
    WHERE clothes.owner_id = ?
    GROUP BY clothes.id
    ORDER BY clothes.id
  `).all(req.user.id);
  res.json(rows.map(clothingFromRow));
});

app.post("/api/clothes", requireUser, (req, res) => {
  const { name, type, styles, warmth, rainproof, photo, color } = req.body;
  if (!name || !type) {
    return res.status(400).json({ error: "Name and type are required." });
  }

  // the photo arrives as text: "data:image/png;base64,....."
  // PNG = cut out (transparent background), JPEG = original photo
  let photoPath = "";
  const formats = { "data:image/png;base64,": ".png", "data:image/jpeg;base64,": ".jpg" };
  for (const prefix in formats) {
    if (typeof photo === "string" && photo.startsWith(prefix)) {
      const fileName = randomPhotoName(formats[prefix]);
      fs.writeFileSync(path.join(PHOTO_DIR, fileName), Buffer.from(photo.slice(prefix.length), "base64"));
      photoPath = "api/photos/" + fileName;
    }
  }

  // the ? marks are filled in by the database itself, in order. NEVER glue user text
  // into SQL with + : someone could type a name like  '); DELETE FROM users; --
  const result = db.prepare(`
    INSERT INTO clothes (owner_id, name, type, styles, warmth, rainproof, photo, color)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.id,
    name.trim(),
    type,
    JSON.stringify(Array.isArray(styles) ? styles : []),
    [1, 2, 3].includes(Number(warmth)) ? Number(warmth) : 2,
    rainproof === true ? 1 : 0,
    photoPath,
    COLORS.includes(color) ? color : ""
  );
  const row = db.prepare("SELECT * FROM clothes WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json(clothingFromRow(row));
});

// the app works out the colour of OLD items in the browser and sends it here.
// PATCH = "change one field", not the whole item
// PATCH = "change only what I send": the colour, the laundry flag, or both
app.patch("/api/clothes/:id", requireUser, (req, res) => {
  const { color, inLaundry } = req.body;
  if (color === undefined && inLaundry === undefined) {
    return res.status(400).json({ error: "Nothing to change." });
  }
  if (color !== undefined && !COLORS.includes(color)) {
    return res.status(400).json({ error: "Unknown colour." });
  }
  const id = Number(req.params.id);
  const item = db.prepare("SELECT id FROM clothes WHERE id = ? AND owner_id = ?").get(id, req.user.id);
  if (!item) {
    return res.status(404).json({ error: "Item not found." });
  }
  if (color !== undefined) db.prepare("UPDATE clothes SET color = ? WHERE id = ?").run(color, id);
  if (inLaundry !== undefined) db.prepare("UPDATE clothes SET in_laundry = ? WHERE id = ?").run(inLaundry ? 1 : 0, id);
  res.status(204).end();
});

// ---------- Learning pairs (👍 and swaps) ----------
const PAIR_LIMIT = 5; // a pair can be between -5 and +5, so one bad day can't erase a month of 👍

// everything the robot learned about YOUR clothes
app.get("/api/pairs", requireUser, (req, res) => {
  const rows = db.prepare(`
    SELECT pair_scores.item_a, pair_scores.item_b, pair_scores.score
    FROM pair_scores
    JOIN clothes ON clothes.id = pair_scores.item_a
    WHERE clothes.owner_id = ?
  `).all(req.user.id);
  res.json(rows.map((r) => ({ a: r.item_a, b: r.item_b, score: r.score })));
});

// { pairs: [[1, 4], [1, 7]], delta: 1 }  -> those pairs go up by 1 (or down, with -1)
app.post("/api/pairs", requireUser, (req, res) => {
  const { pairs, delta } = req.body;
  if (!Array.isArray(pairs) || pairs.length === 0 || ![1, -1].includes(delta)) {
    return res.status(400).json({ error: "Send pairs of items and a delta of 1 or -1." });
  }
  const isMine = db.prepare("SELECT 1 FROM clothes WHERE id = ? AND owner_id = ?");
  const clean = [];
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) return res.status(400).json({ error: "A pair has 2 items." });
    const a = Math.min(Number(pair[0]), Number(pair[1]));
    const b = Math.max(Number(pair[0]), Number(pair[1]));
    if (a === b || !isMine.get(a, req.user.id) || !isMine.get(b, req.user.id)) {
      return res.status(400).json({ error: "Some of those items aren't in your wardrobe." });
    }
    clean.push([a, b]);
  }

  transaction(() => {
    // "UPSERT": insert the pair, or if it already exists, change its score.
    // MAX/MIN keep it between -5 and +5 (a clamp, like in C)
    const upsert = db.prepare(`
      INSERT INTO pair_scores (item_a, item_b, score) VALUES (?, ?, ?)
      ON CONFLICT (item_a, item_b)
      DO UPDATE SET score = MAX(?, MIN(?, score + excluded.score))
    `);
    for (const [a, b] of clean) upsert.run(a, b, delta, -PAIR_LIMIT, PAIR_LIMIT);
  });
  res.status(204).end();
});

// "Wore it": one diary row per item for that day.
// The DATE comes from the phone, because "today" depends on where YOU are, not where the server is.
app.post("/api/wears", requireUser, (req, res) => {
  const { itemIds, date } = req.body;
  if (!Array.isArray(itemIds) || itemIds.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
    return res.status(400).json({ error: "Send the items and a date like 2026-10-25." });
  }
  const ids = [...new Set(itemIds.map(Number))];
  const isMine = db.prepare("SELECT 1 FROM clothes WHERE id = ? AND owner_id = ?");
  if (!ids.every((id) => isMine.get(id, req.user.id))) {
    return res.status(400).json({ error: "Some of those items aren't in your wardrobe." });
  }
  transaction(() => {
    // OR IGNORE: if that day is already in the diary, skip it instead of failing
    const add = db.prepare("INSERT OR IGNORE INTO wears (item_id, worn_on) VALUES (?, ?)");
    for (const id of ids) add.run(id, date);
  });
  res.status(201).json({ itemIds: ids, date });
});

app.delete("/api/clothes/:id", requireUser, (req, res) => {
  // someone else's item gets the same answer as a missing one: "not found"
  const item = db.prepare("SELECT * FROM clothes WHERE id = ? AND owner_id = ?").get(Number(req.params.id), req.user.id);
  if (!item) {
    return res.status(404).json({ error: "Item not found." });
  }
  if (item.photo) {
    fs.rmSync(path.join(PHOTO_DIR, path.basename(item.photo)), { force: true });
  }
  db.prepare("DELETE FROM clothes WHERE id = ?").run(item.id); // CASCADE removes it from outfits too
  res.status(204).end();
});

// ---------- Outfits ----------
// an outfit only remembers WHICH clothes it uses (rows in outfit_items), like pointers in C

app.get("/api/outfits", requireUser, (req, res) => {
  const outfits = db.prepare("SELECT * FROM outfits WHERE owner_id = ? ORDER BY id").all(req.user.id);
  const itemsOf = db.prepare("SELECT item_id FROM outfit_items WHERE outfit_id = ?");
  res.json(outfits.map((o) => ({
    id: o.id,
    name: o.name,
    occasion: o.occasion,
    itemIds: itemsOf.all(o.id).map((r) => r.item_id),
    createdAt: o.created_at
  })));
});

app.post("/api/outfits", requireUser, (req, res) => {
  const { name, occasion, itemIds } = req.body;
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return res.status(400).json({ error: "Pick at least one item." });
  }
  // you can only put YOUR clothes in an outfit
  const ids = [...new Set(itemIds.map(Number))];
  const isMine = db.prepare("SELECT 1 FROM clothes WHERE id = ? AND owner_id = ?");
  if (!ids.every((id) => isMine.get(id, req.user.id))) {
    return res.status(400).json({ error: "Some of those items aren't in your wardrobe." });
  }

  // an outfit is 1 row in outfits + several rows in outfit_items: all of them, or none
  const outfit = transaction(() => {
    const createdAt = new Date().toISOString();
    const outfitName = String(name || "").trim() || "My outfit";
    const result = db.prepare("INSERT INTO outfits (owner_id, name, occasion, created_at) VALUES (?, ?, ?, ?)")
      .run(req.user.id, outfitName, occasion || "casual", createdAt);
    const id = Number(result.lastInsertRowid);
    for (const itemId of ids) {
      db.prepare("INSERT INTO outfit_items (outfit_id, item_id) VALUES (?, ?)").run(id, itemId);
    }
    return { id, name: outfitName, occasion: occasion || "casual", itemIds: ids, createdAt };
  });
  res.status(201).json(outfit);
});

app.delete("/api/outfits/:id", requireUser, (req, res) => {
  const result = db.prepare("DELETE FROM outfits WHERE id = ? AND owner_id = ?").run(Number(req.params.id), req.user.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: "Outfit not found." });
  }
  res.status(204).end();
});

// ---------- Ghost mannequin (AI) ----------
// The browser sends us the cut out photo. WE (the server) talk to the AI,
// because only the server knows the secret key. The browser never sees it.

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
const GEMINI_BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
const DAILY_LIMIT = Number(process.env.GHOST_DAILY_LIMIT || 20); // protects your money

const GHOST_PROMPT =
  "Turn this clothing item into a professional e-commerce 'ghost mannequin' product photo. " +
  "The garment must look like it is worn by an invisible mannequin: natural 3D volume and shape, " +
  "front view, centered, the whole garment visible. Keep the exact colors, fabric texture, logos, " +
  "prints, zippers and every detail identical to the original. Remove any other objects " +
  "(headphones, hangers, hands). Plain light grey background, soft studio light, " +
  "subtle shadow. No person and no visible mannequin.";

let ghostCount = 0;
let ghostDay = new Date().toDateString();

// tells the app which extra features are switched on (without ever sending the key!)
app.get("/api/features", (req, res) => {
  res.json({ ghost: Boolean(GEMINI_KEY) });
});

app.post("/api/ghost", requireUser, async (req, res) => {
  if (!GEMINI_KEY) {
    return res.status(503).json({ error: "The 3D feature is off (no AI key on the server)." });
  }

  // a simple counter that resets every day
  const today = new Date().toDateString();
  if (today !== ghostDay) {
    ghostDay = today;
    ghostCount = 0;
  }
  if (ghostCount >= DAILY_LIMIT) {
    return res.status(429).json({ error: "Daily limit reached. Try again tomorrow." });
  }

  const prefix = "data:image/jpeg;base64,";
  const photo = req.body.photo;
  if (typeof photo !== "string" || !photo.startsWith(prefix)) {
    return res.status(400).json({ error: "Send a JPEG photo." });
  }

  try {
    ghostCount++;
    const url = GEMINI_BASE + "/v1beta/models/" + GEMINI_MODEL + ":generateContent";
    const aiResponse = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: GHOST_PROMPT },
            { inline_data: { mime_type: "image/jpeg", data: photo.slice(prefix.length) } }
          ]
        }]
      })
    });
    const data = await aiResponse.json();
    if (!aiResponse.ok) {
      console.error("AI error:", JSON.stringify(data).slice(0, 500));
      return res.status(502).json({ error: "The AI service said no (" + aiResponse.status + "). Check the terminal." });
    }

    // the answer has several "parts"; we look for the one that is an image
    const parts = data.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find((p) => p.inlineData || p.inline_data);
    if (!imagePart) {
      console.error("AI sent no image:", JSON.stringify(data).slice(0, 500));
      return res.status(502).json({ error: "The AI didn't send back an image. Try another photo." });
    }
    const image = imagePart.inlineData || imagePart.inline_data;
    const mime = image.mimeType || image.mime_type || "image/png";
    res.json({ photo: "data:" + mime + ";base64," + image.data });
  } catch (error) {
    console.error("AI request failed:", error.message);
    res.status(502).json({ error: "Couldn't reach the AI service." });
  }
});

app.listen(PORT, () => {
  console.log("Server running on http://localhost:" + PORT);
});

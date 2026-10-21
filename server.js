const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto"); // built into Node: hashes and random numbers

// secrets (like the AI key) live in a file called .env that git IGNORES,
// so they never end up on GitHub. Node can read that file by itself.
try {
  process.loadEnvFile(); // reads .env into process.env
} catch (error) {
  console.log("No .env file found: the 3D (ghost mannequin) feature will be off.");
}

const app = express();
const PORT = 3000;
const DATA_FILE = "clothes.json";
const OUTFITS_FILE = "outfits.json";
const USERS_FILE = "users.json";       // NEW: accounts (never the real passwords!)
const SESSIONS_FILE = "sessions.json"; // NEW: the "cloakroom tickets" of people who are logged in
const SESSION_DAYS = 30;
const PHOTO_DIR = path.join("public", "uploads");

fs.mkdirSync(PHOTO_DIR, { recursive: true });

app.use(express.static("public"));
app.use(express.json({ limit: "15mb" })); // AI photos can be big // PNG photos are a bit bigger than JPEG

// reads any JSON list from disk (empty list if the file doesn't exist yet)
function readList(file) {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveList(file, list) {
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
}

function nextId(list) {
  return list.length > 0 ? Math.max(...list.map((x) => x.id)) + 1 : 1;
}

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
  const sessions = readList(SESSIONS_FILE).filter((s) => s.expires > Date.now()); // throw away old tickets
  sessions.push({ token, userId, expires: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000 });
  saveList(SESSIONS_FILE, sessions);
  res.setHeader("Set-Cookie", `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`);
}

// who is asking? Returns the user, or null if there is no valid ticket
function currentUser(req) {
  const token = readCookies(req).sid;
  if (!token) return null;
  const session = readList(SESSIONS_FILE).find((s) => s.token === token && s.expires > Date.now());
  if (!session) return null;
  return readList(USERS_FILE).find((u) => u.id === session.userId) || null;
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

  const users = readList(USERS_FILE);
  if (users.some((u) => u.username === username)) {
    return res.status(409).json({ error: "That username is taken." });
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const user = { id: nextId(users), username, salt, hash: hashPassword(password, salt), createdAt: new Date().toISOString() };
  users.push(user);
  saveList(USERS_FILE, users);

  // the very first account adopts the clothes and outfits made before accounts existed
  if (users.length === 1) {
    for (const file of [DATA_FILE, OUTFITS_FILE]) {
      saveList(file, readList(file).map((x) => (x.ownerId ? x : { ...x, ownerId: user.id })));
    }
  }

  giveTicket(res, user.id);
  res.status(201).json(publicUser(user));
});

app.post("/api/login", (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = readList(USERS_FILE).find((u) => u.username === username);

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
  const token = readCookies(req).sid;
  saveList(SESSIONS_FILE, readList(SESSIONS_FILE).filter((s) => s.token !== token)); // tear up the ticket
  res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.status(204).end();
});

app.get("/api/me", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Please log in." });
  res.json(publicUser(user));
});

// ---------- Clothes ----------
// every route below gets requireUser first, and only touches the things with YOUR ownerId

app.get("/api/clothes", requireUser, (req, res) => {
  res.json(readList(DATA_FILE).filter((c) => c.ownerId === req.user.id));
});

app.post("/api/clothes", requireUser, (req, res) => {
  const { name, type, styles, warmth, rainproof, photo } = req.body;
  if (!name || !type) {
    return res.status(400).json({ error: "Name and type are required." });
  }

  const clothes = readList(DATA_FILE);
  const newId = nextId(clothes);

  // the photo arrives as text: "data:image/png;base64,....."
  // PNG = cut out (transparent background), JPEG = original photo
  let photoPath = "";
  const formats = { "data:image/png;base64,": ".png", "data:image/jpeg;base64,": ".jpg" };
  for (const prefix in formats) {
    if (typeof photo === "string" && photo.startsWith(prefix)) {
      const fileName = newId + formats[prefix];
      fs.writeFileSync(path.join(PHOTO_DIR, fileName), Buffer.from(photo.slice(prefix.length), "base64"));
      photoPath = "uploads/" + fileName;
    }
  }

  const item = {
    id: newId,
    ownerId: req.user.id,
    name: name.trim(),
    type,
    styles: Array.isArray(styles) ? styles : [],
    warmth: [1, 2, 3].includes(Number(warmth)) ? Number(warmth) : 2,
    rainproof: rainproof === true,
    photo: photoPath
  };

  clothes.push(item);
  saveList(DATA_FILE, clothes);
  res.status(201).json(item);
});

app.delete("/api/clothes/:id", requireUser, (req, res) => {
  const id = Number(req.params.id);
  const clothes = readList(DATA_FILE);
  // someone else's item gets the same answer as a missing one: "not found"
  const item = clothes.find((c) => c.id === id && c.ownerId === req.user.id);
  if (!item) {
    return res.status(404).json({ error: "Item not found." });
  }
  if (item.photo) {
    fs.rmSync(path.join("public", item.photo), { force: true });
  }
  saveList(DATA_FILE, clothes.filter((c) => c.id !== id));
  res.status(204).end();
});

// ---------- Outfits (NEW) ----------
// an outfit only remembers WHICH clothes it uses (their ids), like pointers in C

app.get("/api/outfits", requireUser, (req, res) => {
  res.json(readList(OUTFITS_FILE).filter((o) => o.ownerId === req.user.id));
});

app.post("/api/outfits", requireUser, (req, res) => {
  const { name, occasion, itemIds } = req.body;
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return res.status(400).json({ error: "Pick at least one item." });
  }
  // you can only put YOUR clothes in an outfit
  const mine = new Set(readList(DATA_FILE).filter((c) => c.ownerId === req.user.id).map((c) => c.id));
  if (!itemIds.every((id) => mine.has(Number(id)))) {
    return res.status(400).json({ error: "Some of those items aren't in your wardrobe." });
  }

  const outfits = readList(OUTFITS_FILE);
  const outfit = {
    id: nextId(outfits),
    ownerId: req.user.id,
    name: (name || "").trim() || "My outfit",
    occasion: occasion || "casual",
    itemIds: itemIds.map(Number),
    createdAt: new Date().toISOString()
  };

  outfits.push(outfit);
  saveList(OUTFITS_FILE, outfits);
  res.status(201).json(outfit);
});

app.delete("/api/outfits/:id", requireUser, (req, res) => {
  const id = Number(req.params.id);
  const outfits = readList(OUTFITS_FILE);
  if (!outfits.some((o) => o.id === id && o.ownerId === req.user.id)) {
    return res.status(404).json({ error: "Outfit not found." });
  }
  saveList(OUTFITS_FILE, outfits.filter((o) => o.id !== id));
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

const express = require("express");
const fs = require("fs");
const path = require("path");

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
const OUTFITS_FILE = "outfits.json"; // NEW: saved outfits live in their own file
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

// ---------- Clothes ----------

app.get("/api/clothes", (req, res) => {
  res.json(readList(DATA_FILE));
});

app.post("/api/clothes", (req, res) => {
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

app.delete("/api/clothes/:id", (req, res) => {
  const id = Number(req.params.id);
  const clothes = readList(DATA_FILE);
  const item = clothes.find((c) => c.id === id);
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

app.get("/api/outfits", (req, res) => {
  res.json(readList(OUTFITS_FILE));
});

app.post("/api/outfits", (req, res) => {
  const { name, occasion, itemIds } = req.body;
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return res.status(400).json({ error: "Pick at least one item." });
  }

  const outfits = readList(OUTFITS_FILE);
  const outfit = {
    id: nextId(outfits),
    name: (name || "").trim() || "My outfit",
    occasion: occasion || "casual",
    itemIds: itemIds.map(Number),
    createdAt: new Date().toISOString()
  };

  outfits.push(outfit);
  saveList(OUTFITS_FILE, outfits);
  res.status(201).json(outfit);
});

app.delete("/api/outfits/:id", (req, res) => {
  const id = Number(req.params.id);
  const outfits = readList(OUTFITS_FILE);
  if (!outfits.some((o) => o.id === id)) {
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

app.post("/api/ghost", async (req, res) => {
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

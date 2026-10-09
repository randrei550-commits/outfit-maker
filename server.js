const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3000;
const DATA_FILE = "clothes.json";
const OUTFITS_FILE = "outfits.json"; // NEW: saved outfits live in their own file
const PHOTO_DIR = path.join("public", "uploads");

fs.mkdirSync(PHOTO_DIR, { recursive: true });

app.use(express.static("public"));
app.use(express.json({ limit: "8mb" })); // PNG photos are a bit bigger than JPEG

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

app.listen(PORT, () => {
  console.log("Server running on http://localhost:" + PORT);
});

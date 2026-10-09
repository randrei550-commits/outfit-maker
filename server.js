const express = require("express");
const fs = require("fs");

const app = express();
const PORT = 3000;
const DATA_FILE = "clothes.json";

app.use(express.static("public")); // the dining room: serves the files in /public
app.use(express.json());           // lets the server read JSON sent by the browser

// helpers: open and close the "fridge"
function readClothes() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}
function saveClothes(clothes) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(clothes, null, 2));
}

// READ: give me all the clothes
app.get("/api/clothes", (req, res) => {
  res.json(readClothes());
});

// CREATE: add a new item
app.post("/api/clothes", (req, res) => {
  const { name, type, styles } = req.body;

  // never trust what comes from outside: check the data first
  if (!name || !type) {
    return res.status(400).json({ error: "Name and type are required." });
  }

  const clothes = readClothes();
  const newId = clothes.length > 0 ? Math.max(...clothes.map((c) => c.id)) + 1 : 1;

  const item = {
    id: newId,
    name: name.trim(),
    type: type,
    styles: Array.isArray(styles) ? styles : [],
    photo: ""
  };

  clothes.push(item);
  saveClothes(clothes);
  res.status(201).json(item); // 201 = "created"
});

app.listen(PORT, () => {
  console.log("Server running on http://localhost:" + PORT);
});

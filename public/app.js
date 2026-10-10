const list = document.getElementById("clothes-list");
const form = document.getElementById("clothing-form");
const statusMessage = document.getElementById("status");
const selectToggle = document.getElementById("select-toggle");
const selectBar = document.getElementById("select-bar");
const deleteButton = document.getElementById("delete-selected");
const navButtons = document.querySelectorAll(".nav-btn");

let selectMode = false; // are we choosing items to delete?
let allClothes = [];    // a copy of the wardrobe
let allOutfits = [];    // saved outfits

// the "slots" of an outfit, in the order we show them
const SLOTS = [
  { type: "top",    label: "Top",    required: true },
  { type: "pants",  label: "Pants",  required: true },
  { type: "shoes",  label: "Shoes",  required: true },
  { type: "jacket", label: "Jacket", required: false }
];

// ---------- Screens (bottom menu) ----------

// "create" has no tab of its own, so the Outfits tab stays lit while you're there
const TAB_FOR = { create: "outfits" };

function showView(name) {
  for (const view of document.querySelectorAll(".view")) {
    view.hidden = view.id !== "view-" + name;
  }
  const tab = TAB_FOR[name] || name;
  for (const button of navButtons) {
    if (button.dataset.view === tab) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  }
  if (name === "outfits") drawBoard();
  if (name === "create") drawCreate();
  if (name === "profile") drawProfile();
  // move keyboard / screen reader focus to the new screen's title
  document.querySelector("#view-" + name + " h1").focus();
  statusMessage.textContent = "";
}

for (const button of navButtons) {
  button.addEventListener("click", () => showView(button.dataset.view));
}

// ---------- Clothes (wardrobe) ----------

// fills a photo box: the real photo if we have one, otherwise the first letter
function fillPhoto(box, item) {
  if (item.photo) {
    const img = document.createElement("img");
    img.src = item.photo;
    img.alt = ""; // the name is written right next to it, so no need to repeat it
    box.appendChild(img);
  } else {
    box.textContent = item.name.charAt(0).toUpperCase();
  }
}

// builds ONE card for ONE item (like a function that fills a struct and returns it)
function createCard(item) {
  const card = document.createElement("li");
  card.className = "card";

  // checkbox only exists in select mode
  if (selectMode) {
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "card-check";
    check.value = item.id;
    check.setAttribute("aria-label", "Select " + item.name); // so a screen reader knows WHICH item
    check.addEventListener("change", updateDeleteButton);
    card.appendChild(check);
  }

  const photo = document.createElement("div");
  photo.className = "card-photo";
  photo.setAttribute("aria-hidden", "true"); // decorative, screen readers skip it
  fillPhoto(photo, item);

  const body = document.createElement("div");
  body.className = "card-body";

  const title = document.createElement("h3");
  title.textContent = item.name;

  const type = document.createElement("p");
  type.className = "type";
  type.textContent = item.type;

  const tags = document.createElement("ul");
  tags.className = "tags";
  tags.setAttribute("aria-label", "Styles");
  for (const style of item.styles) {
    const tag = document.createElement("li");
    tag.className = "tag";
    tag.textContent = style;
    tags.appendChild(tag);
  }

  body.append(title, type, tags);
  card.append(photo, body);
  return card;
}

// asks the server for all clothes and draws them
async function loadClothes() {
  list.innerHTML = ""; // clear the list before drawing it again

  let response;
  try {
    response = await fetch("/api/clothes");
  } catch (error) {
    // no internet, or the laptop with the server is off
    statusMessage.textContent = "You're offline, so we can't load your clothes right now.";
    return;
  }
  if (!response.ok) {
    statusMessage.textContent = "Could not load your wardrobe. Check the terminal for errors.";
    return;
  }
  const clothes = await response.json();
  allClothes = clothes;

  if (clothes.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Your wardrobe is empty. Tap Add to put in your first item.";
    list.appendChild(empty);
  }

  for (const item of clothes) {
    list.appendChild(createCard(item));
  }
  updateDeleteButton();
}

// ---------- Select + Delete ----------

function getSelectedIds() {
  const checked = list.querySelectorAll(".card-check:checked");
  return Array.from(checked).map((box) => Number(box.value));
}

function updateDeleteButton() {
  const count = getSelectedIds().length;
  deleteButton.textContent = "Delete (" + count + ")";
  deleteButton.disabled = count === 0;
}

selectToggle.addEventListener("click", () => {
  selectMode = !selectMode; // flip true <-> false
  selectToggle.setAttribute("aria-pressed", String(selectMode));
  selectToggle.textContent = selectMode ? "Done" : "Select";
  selectBar.hidden = !selectMode;
  loadClothes(); // redraw the cards with or without checkboxes
});

deleteButton.addEventListener("click", async () => {
  const ids = getSelectedIds();
  const word = ids.length === 1 ? "item" : "items";

  // ask before doing something that cannot be undone
  if (!confirm("Delete " + ids.length + " " + word + "? This cannot be undone.")) {
    return;
  }

  for (const id of ids) {
    await fetch("/api/clothes/" + id, { method: "DELETE" });
  }

  statusMessage.textContent = ids.length + " " + word + " deleted.";
  loadClothes();
});

// ---------- Add (with background removal) ----------

const photoInput = document.getElementById("photo");
const photoPreview = document.getElementById("photo-preview");
const photoPlaceholder = document.getElementById("photo-placeholder");
const photoBusy = document.getElementById("photo-busy");
const cutoutBox = document.getElementById("cutout");
const addSubmit = document.getElementById("add-submit");
let photoData = ""; // the chosen photo, as text the server can save

// the AI that finds the item in the photo. It runs IN THE BROWSER (on the phone),
// so our server does no heavy work. It is loaded only the first time we need it.
const CUTOUT_LIBRARY = "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm";

// loads a file/blob into an <img> we can draw on a canvas
function loadImage(source) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(source);
  });
}

// draws an image smaller (max `size` px on the long side) and gives back a canvas
function shrinkToCanvas(img, size) {
  const scale = Math.min(1, size / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// after the cut out, there is lots of empty (transparent) space around the item.
// We find the smallest box that still contains every visible pixel and crop to it,
// so every item ends up nicely centred, like in a shop.
function cropToItem(img) {
  const canvas = shrinkToCanvas(img, 800);
  const ctx = canvas.getContext("2d");
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3]; // 4 values per pixel: R, G, B, A
      if (alpha > 20) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return canvas.toDataURL("image/png"); // nothing found, keep it as it is

  const pad = 12;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);

  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d").drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL("image/png"); // PNG keeps the transparency, JPEG can't
}

async function cutOut(file) {
  // smaller photo = faster AI
  const small = shrinkToCanvas(await loadImage(file), 1024);
  const smallBlob = await new Promise((resolve) => small.toBlob(resolve, "image/jpeg", 0.9));

  const { removeBackground } = await import(CUTOUT_LIBRARY);
  const result = await removeBackground(smallBlob, {
    model: "isnet_quint8", // the small, fast model
    output: { format: "image/png" },
    progress: (key, current, total) => {
      if (key.startsWith("fetch:")) {
        photoBusy.textContent = "Getting the AI ready (first time only)… " + Math.round((current / total) * 100) + "%";
      } else {
        photoBusy.textContent = "Cutting out your item…";
      }
    }
  });
  return cropToItem(await loadImage(result));
}

photoInput.addEventListener("change", async () => {
  const file = photoInput.files[0];
  if (!file) return;

  photoPlaceholder.hidden = true;
  addSubmit.disabled = true; // don't save while the photo is still being prepared
  const original = shrinkToCanvas(await loadImage(file), 800).toDataURL("image/jpeg", 0.85);
  photoPreview.src = original;
  photoPreview.hidden = false;

  if (!cutoutBox.checked) {
    photoData = original;
    statusMessage.textContent = "Photo ready.";
    addSubmit.disabled = false;
    return;
  }

  photoBusy.textContent = "Cutting out your item…";
  photoBusy.hidden = false;
  statusMessage.textContent = "Removing the background…";
  try {
    photoData = await cutOut(file);
    photoPreview.src = photoData;
    photoPreview.classList.add("is-cutout");
    statusMessage.textContent = "Background removed. Photo ready.";
  } catch (error) {
    // no internet, old phone, etc.: keep the normal photo so the user isn't stuck
    console.error(error);
    photoData = original;
    statusMessage.textContent = "Couldn't remove the background, so we kept the normal photo.";
  }
  photoBusy.hidden = true;
  addSubmit.disabled = false;
});

function resetPhoto() {
  photoData = "";
  photoInput.value = "";
  photoPreview.hidden = true;
  photoPreview.classList.remove("is-cutout");
  photoPlaceholder.hidden = false;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault(); // stop the browser from reloading the page

  const data = new FormData(form);
  const newItem = {
    name: data.get("name"),
    type: data.get("type"),
    styles: data.getAll("styles"), // getAll = every checked box, as an array
    warmth: Number(data.get("warmth")),
    rainproof: data.get("rainproof") === "yes",
    photo: photoData
  };

  const response = await fetch("/api/clothes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(newItem)
  });

  if (response.ok) {
    form.reset();
    resetPhoto();
    await loadClothes();
    showView("clothes");
    statusMessage.textContent = newItem.name + " was added to your wardrobe.";
  } else {
    const error = await response.json();
    statusMessage.textContent = "Could not add the item: " + error.error;
  }
});

// ---------- Home: outfit of the day ----------

const outfitList = document.getElementById("outfit");
const generateButton = document.getElementById("generate-btn");
const surpriseButton = document.getElementById("surprise-btn");
const homeActions = document.getElementById("home-actions");

let currentOutfit = []; // what is on screen right now
let currentStyle = null; // null = "Surprise me" (all clothes)
let currentWeather = null;

// ---------- Weather ----------

const weatherText = document.getElementById("weather-text");
let todayCache = null; // so we don't ask the weather service on every click

// asks the browser where we are (the browser asks the user for permission)
function getPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 8000 });
  });
}

async function getTodayWeather() {
  if (todayCache) return todayCache;

  const pos = await getPosition();
  const url = "https://api.open-meteo.com/v1/forecast"
    + "?latitude=" + pos.coords.latitude
    + "&longitude=" + pos.coords.longitude
    + "&current=temperature_2m"
    + "&hourly=temperature_2m,precipitation_probability"
    + "&forecast_days=1&timezone=auto";

  const response = await fetch(url); // Open-Meteo is free and needs no key
  const data = await response.json();

  // look only at the hours from now until 22:00
  const nowHour = new Date().getHours();
  const hours = data.hourly.time.map((t, i) => ({
    hour: Number(t.slice(11, 13)),
    temp: data.hourly.temperature_2m[i],
    rain: data.hourly.precipitation_probability[i]
  })).filter((h) => h.hour >= nowHour && h.hour <= 22);

  const coldest = hours.reduce((a, b) => (b.temp < a.temp ? b : a), hours[0]);
  const temp = Math.round(data.current.temperature_2m);
  const later = Math.round(coldest.temp);
  const rain = Math.max(...hours.map((h) => h.rain));

  let text = temp + "°C now";
  if (temp - later >= 4) text += ", " + later + "°C by " + coldest.hour + ":00";
  text += ", " + rain + "% chance of rain.";

  todayCache = { temp, later, rain, text };
  return todayCache;
}

// turns the weather into simple rules for the generator
function weatherRules(w) {
  const target = w.temp >= 22 ? 1 : w.temp >= 13 ? 2 : 3; // 1 light, 2 medium, 3 warm
  const rainy = w.rain >= 50;
  const needJacket = w.later < 17 || rainy;
  let advice = needJacket ? "Take a jacket" : "No jacket needed";
  if (rainy) advice = "Take a rain jacket";
  else if (w.temp - w.later >= 4 && needJacket) advice = "Take a jacket for later";
  return { target, rainy, needJacket, advice };
}

// the weather always decides: no buttons needed
async function readWeather() {
  try {
    weatherText.textContent = "Checking the weather near you…";
    return await getTodayWeather();
  } catch (error) {
    // location refused, or no internet: use a safe middle ground
    weatherText.textContent = "Couldn't check the weather (location blocked or no internet), so we ignored it this time.";
    return null;
  }
}

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

// keeps only clothes that fit the weather (if we know it)
function fitsWeather(item, slot) {
  if (!currentWeather) return true;
  const warmth = item.warmth || 2;
  if (slot.type === "jacket" && currentWeather.rainy) return item.rainproof === true;
  return Math.abs(warmth - currentWeather.target) <= 1;
}

// all clothes that could go in this slot
function candidatesFor(slot, style) {
  const sameType = allClothes.filter((c) => c.type === slot.type);
  const goodWeather = sameType.filter((c) => fitsWeather(c, slot));
  const base = goodWeather.length > 0 ? goodWeather : sameType; // weather is a wish, not a must

  if (style === null) {
    return { pool: base, fallback: false };
  }
  const sameStyle = base.filter((c) => c.styles.includes(style));
  if (sameStyle.length > 0) {
    return { pool: sameStyle, fallback: false };
  }
  // plan B: nothing in this style, so we look in the whole wardrobe
  return { pool: slot.required ? base : [], fallback: true };
}

async function generate(style) {
  currentStyle = style;
  currentOutfit = [];

  const weather = await readWeather();
  currentWeather = weather ? weatherRules(weather) : null;
  if (weather) {
    weatherText.textContent = weather.text + " " + currentWeather.advice + ".";
  }

  for (const slot of SLOTS) {
    // the jacket only comes along when the weather asks for it
    if (slot.type === "jacket" && currentWeather && !currentWeather.needJacket) continue;
    const { pool, fallback } = candidatesFor(slot, style);
    if (pool.length === 0) {
      if (slot.required) currentOutfit.push({ slot, item: null, fallback: false });
      continue; // optional piece with nothing to choose: just skip it
    }
    currentOutfit.push({ slot, item: pickRandom(pool), fallback });
  }

  drawOutfit();

  const missing = currentOutfit.filter((p) => p.item === null).map((p) => p.slot.label.toLowerCase());
  const label = style === null ? "Surprise outfit" : capitalize(style) + " outfit";
  const advice = currentWeather ? " " + currentWeather.advice + "." : "";
  statusMessage.textContent = missing.length > 0
    ? label + " ready, but you have no " + missing.join(", ") + " yet." + advice
    : label + " ready." + advice;
}

// replace ONLY one piece, keep the rest of the outfit
function swapPiece(index) {
  const piece = currentOutfit[index];
  const { pool } = candidatesFor(piece.slot, currentStyle);
  const others = pool.filter((c) => c.id !== piece.item.id);

  if (others.length === 0) {
    statusMessage.textContent = "No other " + piece.slot.label.toLowerCase() + " to swap in.";
    return;
  }
  piece.item = pickRandom(others);
  drawOutfit();
  statusMessage.textContent = piece.slot.label + " swapped to " + piece.item.name + ".";
  // keep focus on the same swap button so keyboard users don't get lost
  const button = outfitList.querySelectorAll(".swap-btn")[index];
  if (button) button.focus();
}

function drawOutfit() {
  outfitList.innerHTML = "";

  currentOutfit.forEach((piece, index) => {
    const li = document.createElement("li");
    li.className = "piece";

    const photo = document.createElement("div");
    photo.className = "piece-photo";
    photo.setAttribute("aria-hidden", "true");

    const text = document.createElement("div");
    const slot = document.createElement("p");
    slot.className = "piece-slot";
    slot.textContent = piece.slot.label;
    const name = document.createElement("p");
    name.className = "piece-name";
    text.append(slot, name);

    if (piece.item === null) {
      li.classList.add("missing");
      name.textContent = "Nothing here yet";
      const note = document.createElement("p");
      note.className = "piece-note";
      note.textContent = "Add some " + piece.slot.label.toLowerCase() + " to your wardrobe.";
      text.appendChild(note);
      li.append(photo, text);
    } else {
      fillPhoto(photo, piece.item);
      name.textContent = piece.item.name;
      if (piece.fallback) {
        const note = document.createElement("p");
        note.className = "piece-note";
        note.textContent = "No " + currentStyle + " " + piece.slot.label.toLowerCase() + ", so we picked from all of them.";
        text.appendChild(note);
      }

      const swap = document.createElement("button");
      swap.className = "swap-btn";
      swap.textContent = "↻";
      swap.setAttribute("aria-label", "Swap " + piece.slot.label.toLowerCase() + ", now " + piece.item.name);
      swap.addEventListener("click", () => swapPiece(index));
      li.append(photo, text, swap);
    }

    outfitList.appendChild(li);
  });

  homeActions.hidden = currentOutfit.every((p) => p.item === null);
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// turns what is on Home into an outfit "object" the Outfits tab understands
function outfitFromHome() {
  const label = currentStyle === null ? "Surprise outfit" : capitalize(currentStyle) + " outfit";
  return {
    id: null, // null = not saved yet
    name: label,
    occasion: currentStyle || "casual",
    itemIds: currentOutfit.filter((p) => p.item).map((p) => p.item.id)
  };
}

generateButton.addEventListener("click", () => {
  const chosen = document.querySelector('input[name="mood"]:checked').value;
  generate(chosen);
});

surpriseButton.addEventListener("click", () => generate(null)); // the funny button: all clothes

document.getElementById("style-it-btn").addEventListener("click", () => {
  boardOutfit = outfitFromHome();
  showView("outfits");
});

document.getElementById("save-generated-btn").addEventListener("click", async () => {
  const saved = await saveOutfit(outfitFromHome());
  if (saved) statusMessage.textContent = saved.name + " saved to Outfits.";
});

// ---------- Outfits: the flat lay "mannequin" ----------

const board = document.getElementById("board");
const boardCaption = document.getElementById("board-caption");
const boardActions = document.getElementById("board-actions");
const boardSaveButton = document.getElementById("board-save-btn");
const boardDeleteButton = document.getElementById("board-delete-btn");
const savedList = document.getElementById("saved-list");

let boardOutfit = null; // the outfit shown big on the board

// WHERE each piece sits on the board, in % of its width/height.
// The screen AND the shared image both use this one table, so they always match.
const LAYOUT = {
  jacket: { x: 50, y: 4,  w: 46, h: 42, z: 1 },
  top:    { x: 8,  y: 6,  w: 50, h: 40, z: 2 },
  pants:  { x: 14, y: 44, w: 44, h: 52, z: 2 },
  shoes:  { x: 58, y: 70, w: 36, h: 24, z: 3 }
};
// without a jacket, the top moves to the middle
const LAYOUT_NO_JACKET = {
  top:    { x: 22, y: 4,  w: 56, h: 42, z: 2 },
  pants:  { x: 12, y: 44, w: 46, h: 52, z: 2 },
  shoes:  { x: 58, y: 66, w: 36, h: 26, z: 3 }
};

// ids -> real items (an item may have been deleted since, so we skip those)
function itemsOf(outfit) {
  return outfit.itemIds.map((id) => allClothes.find((c) => c.id === id)).filter(Boolean);
}

function layoutFor(items) {
  return items.some((i) => i.type === "jacket") ? LAYOUT : LAYOUT_NO_JACKET;
}

// draws an outfit inside a box (used for the big board AND the small saved cards)
function fillBoard(box, outfit) {
  box.innerHTML = "";
  const items = itemsOf(outfit);
  const layout = layoutFor(items);

  for (const item of items) {
    const place = layout[item.type];
    if (!place) continue;
    const piece = document.createElement("div");
    piece.className = "board-piece" + (item.photo ? "" : " no-photo");
    piece.style.left = place.x + "%";
    piece.style.top = place.y + "%";
    piece.style.width = place.w + "%";
    piece.style.height = place.h + "%";
    piece.style.zIndex = place.z;
    if (item.photo) {
      const img = document.createElement("img");
      img.src = item.photo;
      img.alt = "";
      piece.appendChild(img);
    } else {
      piece.textContent = item.name; // no photo yet: show the name on a soft tile
    }
    box.appendChild(piece);
  }
  return items;
}

function drawBoard() {
  if (!boardOutfit && allOutfits.length > 0) boardOutfit = allOutfits[allOutfits.length - 1];

  if (!boardOutfit) {
    board.innerHTML = "";
    board.setAttribute("aria-label", "No outfit yet");
    boardCaption.textContent = "Generate an outfit on Home or create your own.";
    boardActions.hidden = true;
  } else {
    const items = fillBoard(board, boardOutfit);
    board.setAttribute("aria-label", boardOutfit.name + ": " + items.map((i) => i.name).join(", "));
    boardCaption.textContent = boardOutfit.name + " · " + capitalize(boardOutfit.occasion);
    boardActions.hidden = false;
    boardSaveButton.hidden = boardOutfit.id !== null;   // already saved? no Save button
    boardDeleteButton.hidden = boardOutfit.id === null; // not saved? nothing to delete
  }
  drawSaved();
}

function drawSaved() {
  savedList.innerHTML = "";
  if (allOutfits.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No saved outfits yet.";
    savedList.appendChild(empty);
    return;
  }
  // newest first
  for (const outfit of [...allOutfits].reverse()) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.className = "saved-card";
    if (boardOutfit && boardOutfit.id === outfit.id) button.setAttribute("aria-current", "true");

    const mini = document.createElement("div");
    mini.className = "board mini";
    mini.setAttribute("aria-hidden", "true");
    fillBoard(mini, outfit);

    const name = document.createElement("span");
    name.className = "saved-name";
    name.textContent = outfit.name;

    button.append(mini, name);
    button.addEventListener("click", () => {
      boardOutfit = outfit;
      drawBoard();
      board.scrollIntoView({ behavior: "smooth", block: "center" });
      statusMessage.textContent = outfit.name + " is on the board.";
    });
    li.appendChild(button);
    savedList.appendChild(li);
  }
}

async function loadOutfits() {
  try {
    const response = await fetch("/api/outfits");
    if (response.ok) allOutfits = await response.json();
  } catch (error) {
    // offline: loadClothes already shows the message
  }
}

async function saveOutfit(outfit) {
  const response = await fetch("/api/outfits", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: outfit.name, occasion: outfit.occasion, itemIds: outfit.itemIds })
  });
  if (!response.ok) {
    const error = await response.json();
    statusMessage.textContent = "Could not save: " + error.error;
    return null;
  }
  const saved = await response.json();
  allOutfits.push(saved);
  return saved;
}

boardSaveButton.addEventListener("click", async () => {
  const saved = await saveOutfit(boardOutfit);
  if (!saved) return;
  boardOutfit = saved;
  drawBoard();
  statusMessage.textContent = saved.name + " saved.";
  boardDeleteButton.focus();
});

boardDeleteButton.addEventListener("click", async () => {
  if (!confirm("Delete " + boardOutfit.name + "? Your clothes stay in your wardrobe.")) return;
  await fetch("/api/outfits/" + boardOutfit.id, { method: "DELETE" });
  const name = boardOutfit.name;
  allOutfits = allOutfits.filter((o) => o.id !== boardOutfit.id);
  boardOutfit = null;
  drawBoard();
  statusMessage.textContent = name + " deleted.";
  document.getElementById("outfits-title").focus();
});

// ---------- Share: turn the board into a picture ----------

// draws a picture so it fits inside a box without stretching (like CSS "contain")
function drawContained(ctx, img, x, y, w, h) {
  const scale = Math.min(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function imageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

async function makeShareImage(outfit) {
  const W = 1080, H = 1350; // the size Instagram likes for a post (4:5)
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#EFEBE4";
  ctx.fillRect(0, 0, W, H);

  // the board area leaves room at the bottom for the name
  const area = { x: 60, y: 60, w: W - 120, h: H - 260 };
  const items = itemsOf(outfit);
  const layout = layoutFor(items);
  const sorted = [...items].sort((a, b) => (layout[a.type]?.z || 0) - (layout[b.type]?.z || 0));

  for (const item of sorted) {
    const place = layout[item.type];
    if (!place) continue;
    const x = area.x + (place.x / 100) * area.w;
    const y = area.y + (place.y / 100) * area.h;
    const w = (place.w / 100) * area.w;
    const h = (place.h / 100) * area.h;
    if (item.photo) {
      drawContained(ctx, await imageFromUrl(item.photo), x, y, w, h);
    } else {
      ctx.fillStyle = "#E2DCD2";
      ctx.beginPath();
      ctx.roundRect(x + 10, y + 10, w - 20, h - 20, 32);
      ctx.fill();
      ctx.fillStyle = "#6B645B";
      ctx.font = "500 34px 'DM Sans', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(item.name, x + w / 2, y + h / 2, w - 40);
    }
  }

  ctx.textAlign = "left";
  ctx.fillStyle = "#2B2620";
  ctx.font = "600 64px 'Cormorant Garamond', Georgia, serif";
  ctx.fillText(outfit.name, 60, H - 110);
  ctx.fillStyle = "#6B645B";
  ctx.font = "500 30px 'DM Sans', sans-serif";
  ctx.fillText("made with Outfit Maker", 60, H - 60);

  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

document.getElementById("share-btn").addEventListener("click", async () => {
  statusMessage.textContent = "Making your picture…";
  const blob = await makeShareImage(boardOutfit);
  const file = new File([blob], "outfit.png", { type: "image/png" });

  // on phones this opens the share menu, where you pick Instagram, TikTok, etc.
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: boardOutfit.name });
      statusMessage.textContent = "Shared!";
    } catch (error) {
      statusMessage.textContent = "Sharing cancelled.";
    }
    return;
  }
  // computers usually can't share files, so we download the picture instead
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "outfit.png";
  link.click();
  statusMessage.textContent = "Picture downloaded. You can post it from your gallery.";
});

// ---------- Create your own ----------

const tray = document.getElementById("tray");
const trayCount = document.getElementById("tray-count");
const pickList = document.getElementById("pick-list");
const outfitNameInput = document.getElementById("outfit-name");
const saveCreatedButton = document.getElementById("save-created-btn");

// one piece per type: { top: item, pants: item, ... }
let picks = {};

document.getElementById("create-btn").addEventListener("click", () => {
  picks = {};
  outfitNameInput.value = "";
  showView("create");
});

document.getElementById("back-btn").addEventListener("click", () => showView("outfits"));

function togglePick(item) {
  if (picks[item.type] && picks[item.type].id === item.id) {
    delete picks[item.type]; // tapped again = take it off
  } else {
    picks[item.type] = item; // a new top replaces the old top
  }
  drawCreate();
  // keep focus on the same item so keyboard users don't get lost
  const same = pickList.querySelector('[data-id="' + item.id + '"]');
  if (same) same.focus();
}

function drawCreate() {
  // the tray at the top with what you picked
  tray.innerHTML = "";
  const chosen = SLOTS.map((s) => picks[s.type]).filter(Boolean);
  for (const item of chosen) {
    const li = document.createElement("li");
    li.className = "tray-item";
    const photo = document.createElement("div");
    photo.className = "card-photo";
    photo.setAttribute("aria-hidden", "true");
    fillPhoto(photo, item);
    const remove = document.createElement("button");
    remove.className = "tray-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Remove " + item.name);
    remove.addEventListener("click", () => {
      delete picks[item.type];
      drawCreate();
      statusMessage.textContent = item.name + " removed.";
    });
    li.append(photo, remove);
    tray.appendChild(li);
  }
  trayCount.textContent = chosen.length === 0
    ? "Nothing picked yet."
    : chosen.length + (chosen.length === 1 ? " item" : " items");
  saveCreatedButton.disabled = chosen.length === 0;

  // the grid of clothes you can pick from
  const filter = document.querySelector('input[name="filter"]:checked').value;
  pickList.innerHTML = "";
  const shown = allClothes.filter((c) => filter === "all" || c.type === filter);
  if (shown.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Nothing here yet.";
    pickList.appendChild(empty);
  }
  for (const item of shown) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.className = "pick-card";
    button.dataset.id = item.id;
    const isPicked = picks[item.type] && picks[item.type].id === item.id;
    button.setAttribute("aria-pressed", String(Boolean(isPicked)));

    const photo = document.createElement("div");
    photo.className = "card-photo";
    photo.setAttribute("aria-hidden", "true");
    fillPhoto(photo, item);

    const name = document.createElement("span");
    name.className = "pick-name";
    name.textContent = item.name;
    const type = document.createElement("span");
    type.className = "pick-type";
    type.textContent = item.type;

    button.append(photo, name, type);
    button.addEventListener("click", () => togglePick(item));
    li.appendChild(button);
    pickList.appendChild(li);
  }
}

for (const radio of document.querySelectorAll('input[name="filter"]')) {
  radio.addEventListener("change", drawCreate);
}

// the "funny" button: fills only the empty slots, keeps what you chose
document.getElementById("fill-random-btn").addEventListener("click", () => {
  let added = 0;
  for (const slot of SLOTS) {
    if (picks[slot.type] || !slot.required) continue;
    const options = allClothes.filter((c) => c.type === slot.type);
    if (options.length > 0) {
      picks[slot.type] = pickRandom(options);
      added++;
    }
  }
  drawCreate();
  statusMessage.textContent = added > 0 ? "Added " + added + " random " + (added === 1 ? "piece." : "pieces.") : "Nothing left to fill.";
});

saveCreatedButton.addEventListener("click", async () => {
  const occasion = document.querySelector('input[name="occasion"]:checked').value;
  const saved = await saveOutfit({
    name: outfitNameInput.value,
    occasion,
    itemIds: SLOTS.map((s) => picks[s.type]).filter(Boolean).map((i) => i.id)
  });
  if (!saved) return;
  boardOutfit = saved;
  showView("outfits");
  statusMessage.textContent = saved.name + " saved.";
});

// ---------- Profile ----------

function drawProfile() {
  const stats = document.getElementById("stats");
  stats.innerHTML = "";

  // which style shows up most often? (count them, like an array of counters in C)
  const counts = {};
  for (const item of allClothes) {
    for (const style of item.styles) counts[style] = (counts[style] || 0) + 1;
  }
  const topStyle = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];

  const tiles = [
    { value: allClothes.length, label: "Items" },
    { value: allOutfits.length, label: "Saved outfits" },
    { value: topStyle ? capitalize(topStyle) : "–", label: "Your style" }
  ];
  for (const tile of tiles) {
    const li = document.createElement("li");
    li.className = "stat";
    const value = document.createElement("strong");
    value.textContent = tile.value;
    const label = document.createElement("span");
    label.textContent = tile.label;
    li.append(value, label);
    stats.appendChild(li);
  }

  const breakdown = document.getElementById("type-breakdown");
  breakdown.innerHTML = "";
  for (const slot of SLOTS) {
    const li = document.createElement("li");
    const count = allClothes.filter((c) => c.type === slot.type).length;
    const name = document.createElement("span");
    name.textContent = slot.label;
    const number = document.createElement("span");
    number.textContent = count;
    li.append(name, number);
    breakdown.appendChild(li);
  }
}

// ---------- Start ----------

async function start() {
  await Promise.all([loadClothes(), loadOutfits()]);
}

// the service worker (sw.js) lets the app open even without internet
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js");
}

start();

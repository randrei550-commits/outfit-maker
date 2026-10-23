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

// ---------- Talking to our server ----------
// Every request for YOUR data goes through here. If the server answers 401
// ("who are you?"), the ticket is gone, so we close the app and show the login screen.
// One check in one place, instead of an if after every fetch.
async function api(url, options) {
  const response = await fetch(url, options);
  if (response.status === 401) showAuth();
  return response;
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
  if (item.color) {
    const dot = document.createElement("span");
    dot.className = "color-dot color-" + item.color;
    dot.setAttribute("aria-hidden", "true");
    type.append(" · " + item.color + " ", dot);
  }

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
    response = await api("/api/clothes");
  } catch (error) {
    // no internet, or the laptop with the server is off
    statusMessage.textContent = "You're offline, so we can't load your clothes right now.";
    return;
  }
  if (response.status === 401) return showAuth(); // the ticket expired: log in again
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
  fillMissingColors(clothes); // no await: it works in the background
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
    await api("/api/clothes/" + id, { method: "DELETE" });
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
const ghostBox = document.getElementById("ghost");
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

// The AI sometimes keeps small extra things from the photo (a sock on the floor,
// a bit of the bed). We look for "islands" of visible pixels and keep only the
// big ones. Same idea as flood fill in C: start at a pixel, visit every neighbour
// that is also visible, count how many we found.
function keepBigPieces(data, width, height) {
  const label = new Int32Array(width * height); // 0 = not visited yet, like calloc
  const queue = new Int32Array(width * height); // our own stack, no recursion
  const sizes = [0]; // sizes[n] = how many pixels island n has
  const visible = (i) => data[i * 4 + 3] > 20;

  for (let start = 0; start < width * height; start++) {
    if (label[start] || !visible(start)) continue;
    const id = sizes.length;
    let head = 0, tail = 0;
    queue[tail++] = start;
    label[start] = id;
    while (head < tail) {
      const i = queue[head++];
      const x = i % width;
      // the 4 neighbours: left, right, up, down
      const around = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width];
      for (const n of around) {
        if (n >= 0 && n < width * height && !label[n] && visible(n)) {
          label[n] = id;
          queue[tail++] = n;
        }
      }
    }
    sizes.push(tail); // tail = how many pixels went through the queue
  }

  // keep every island at least 1/4 of the biggest one (so a PAIR of shoes stays)
  const biggest = Math.max(...sizes);
  for (let i = 0; i < width * height; i++) {
    if (label[i] && sizes[label[i]] < biggest / 4) data[i * 4 + 3] = 0; // make it invisible
  }
}

// how bright the item is, from 0 (black) to 255 (white). We only count visible pixels.
function averageBrightness(data) {
  let sum = 0, count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 20) {
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; // how our eyes see colours
      count++;
    }
  }
  return count ? sum / count : 128;
}

// dark clothes in a normal room come out almost black and you lose the details
// (seams, pockets, folds). We lift the dark tones and leave the light ones alone.
// pow(x, 0.75) does that: 0 stays 0, 1 stays 1, everything in between gets brighter.
function liftShadows(data) {
  const table = new Uint8ClampedArray(256); // pre-computed, like a lookup table in C
  for (let v = 0; v < 256; v++) table[v] = 255 * Math.pow(v / 255, 0.75);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = table[data[i]];
    data[i + 1] = table[data[i + 1]];
    data[i + 2] = table[data[i + 2]];
  }
}

// after the cut out, there is lots of empty (transparent) space around the item.
// We find the smallest box that still contains every visible pixel and crop to it,
// so every item ends up nicely centred, like in a shop.
function cropToItem(img) {
  const canvas = shrinkToCanvas(img, 800);
  const ctx = canvas.getContext("2d");
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = pixels;

  keepBigPieces(data, width, height);
  const brightness = averageBrightness(data);
  const isDark = brightness < 70;
  if (isDark) liftShadows(data);
  ctx.putImageData(pixels, 0, 0);

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
  studioLight(out, isDark);
  return out.toDataURL("image/png"); // PNG keeps the transparency, JPEG can't
}

// a free "studio" touch: a bit of light at the top and a bit of shade at the bottom,
// so the item looks rounder, like it was photographed in a studio.
// "source-atop" = paint ONLY where the item is, never on the transparent background.
// Dark items get more light and almost no shade, or they would turn into a black blob.
function studioLight(canvas, isDark) {
  const ctx = canvas.getContext("2d");
  const look = isDark
    ? { top: 0.16, bottom: 0.04, edges: 0.06 }
    : { top: 0.10, bottom: 0.14, edges: 0.16 };
  ctx.globalCompositeOperation = "source-atop";

  const light = ctx.createLinearGradient(0, 0, 0, canvas.height);
  light.addColorStop(0, "rgba(255, 255, 255, " + look.top + ")");
  light.addColorStop(0.45, "rgba(255, 255, 255, 0)");
  light.addColorStop(1, "rgba(0, 0, 0, " + look.bottom + ")");
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // the edges get slightly darker, the middle stays bright: that reads as "volume"
  const r = Math.max(canvas.width, canvas.height) * 0.75;
  const edges = ctx.createRadialGradient(canvas.width / 2, canvas.height * 0.4, r * 0.35, canvas.width / 2, canvas.height * 0.4, r);
  edges.addColorStop(0, "rgba(0, 0, 0, 0)");
  edges.addColorStop(1, "rgba(0, 0, 0, " + look.edges + ")");
  ctx.fillStyle = edges;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.globalCompositeOperation = "source-over"; // back to normal drawing
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

// puts the cut out item on a light grey background and turns it into a JPEG,
// because AI models don't handle transparent pictures well
async function onGrey(pngData) {
  const img = await imageFromUrl(pngData);
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#EFEBE4";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL("image/jpeg", 0.9);
}

// sends the photo to OUR server, which asks the AI for a ghost mannequin version.
// Then we cut the new picture out again, so it has a transparent background.
async function makeGhost(cutoutData) {
  const response = await api("/api/ghost", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ photo: await onGrey(cutoutData) })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);

  const aiBlob = await (await fetch(result.photo)).blob(); // text -> picture file
  return cutOut(aiBlob);
}

photoInput.addEventListener("change", () => {
  const file = photoInput.files[0];
  if (file) handlePhoto(file);
});

// everything that happens to a new photo, whether it came from the camera or the gallery
async function handlePhoto(file) {
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

  // step 2 (optional): the AI gives the item a "worn" 3D shape
  if (ghostBox.checked && photoData !== original) {
    photoBusy.textContent = "Giving it shape with AI…";
    statusMessage.textContent = "Making it 3D. This can take up to a minute.";
    try {
      photoData = await makeGhost(photoData);
      photoPreview.src = photoData;
      statusMessage.textContent = "Your item is ready in 3D.";
    } catch (error) {
      console.error(error);
      statusMessage.textContent = "The 3D step didn't work (" + error.message + "), so we kept the cut out photo.";
    }
  }
  photoBusy.hidden = true;
  addSubmit.disabled = false;
}

// ---------- Camera with a guide ----------
// The outline shows WHERE to put the item. A hanging item has a natural 3D shape
// (gravity does the job of the AI), so we ask for tops, jackets and pants on a hanger.

const camera = document.getElementById("camera");
const cameraVideo = document.getElementById("camera-video");
const cameraTip = document.getElementById("camera-tip");
const cameraButton = document.getElementById("camera-btn");
const typeSelect = document.getElementById("type");
let cameraStream = null;

const HANGER = "M150 26 a14 14 0 1 1 14 16 q-14 4 -14 14 v8 M150 64 L95 92 M150 64 L205 92";
const GUIDES = {
  top: {
    hanger: true,
    shape: "M150 64 L95 88 L45 150 L78 172 L100 142 L100 360 L200 360 L200 142 L222 172 L255 150 L205 88 Z",
    tip: "Hang it on a hanger against a plain wall and fill the outline."
  },
  jacket: {
    hanger: true,
    shape: "M150 64 L92 88 L60 150 L48 305 L82 309 L100 172 L100 362 L200 362 L200 172 L218 309 L252 305 L240 150 L208 88 Z",
    tip: "Hang it on a hanger against a plain wall. Close the zip for the best shape."
  },
  pants: {
    hanger: true,
    shape: "M95 92 H205 L216 372 H162 L150 170 L138 372 H84 Z",
    tip: "Hang them by the waist against a plain wall and fill the outline."
  },
  shoes: {
    hanger: false,
    shape: "M48 290 Q46 238 104 226 L146 196 Q172 184 190 208 L250 248 Q272 262 270 292 Z",
    tip: "Put one shoe on the floor, side view, on a plain background."
  }
};

function drawGuide(type) {
  const guide = GUIDES[type] || GUIDES.top;
  document.getElementById("guide-shape").setAttribute("d", guide.shape);
  document.getElementById("guide-hanger").setAttribute("d", guide.hanger ? HANGER : "");
  cameraTip.textContent = guide.tip;
  document.querySelector('input[name="camtype"][value="' + type + '"]').checked = true;
}

// the chips in the camera and the Type list in the form always show the same thing
for (const radio of document.querySelectorAll('input[name="camtype"]')) {
  radio.addEventListener("change", () => {
    typeSelect.value = radio.value;
    drawGuide(radio.value);
  });
}

cameraButton.addEventListener("click", async () => {
  // old phones or plain http: no live camera, so we open the normal photo picker instead
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    photoInput.click();
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1920 } },
      audio: false
    });
  } catch (error) {
    statusMessage.textContent = "We couldn't open the camera (permission blocked?). Use From gallery instead.";
    return;
  }
  cameraVideo.srcObject = cameraStream;
  drawGuide(typeSelect.value);
  camera.hidden = false;
  document.body.classList.add("camera-open");
  document.getElementById("camera-shot").focus();
});

function closeCamera() {
  if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop()); // turns the camera light off
  cameraStream = null;
  camera.hidden = true;
  document.body.classList.remove("camera-open");
  cameraButton.focus();
}

document.getElementById("camera-close").addEventListener("click", closeCamera);
camera.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeCamera();
});

document.getElementById("camera-shot").addEventListener("click", async () => {
  // take one frame from the live video and turn it into a picture file
  const canvas = document.createElement("canvas");
  canvas.width = cameraVideo.videoWidth;
  canvas.height = cameraVideo.videoHeight;
  canvas.getContext("2d").drawImage(cameraVideo, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  const tooDark = averageBrightness(shrinkToCanvas(canvas, 64).getContext("2d").getImageData(0, 0, 64, 64).data) < 60;
  closeCamera();
  await handlePhoto(blob);
  if (tooDark) statusMessage.textContent += " Tip: the room was dark. More light gives a sharper cut out.";
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
    photo: photoData,
    // only cut outs: in a normal photo the wall behind would count as the colour
    color: photoData.startsWith("data:image/png") ? await mainColor(photoData) : ""
  };

  const response = await api("/api/clothes", {
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

// ---------- Colours ----------
// The app works out the main colour of an item from its cut out photo.
// RGB is how screens store colour; HSL is how people think about it:
// H = hue (which colour, 0-360 on a colour wheel), S = saturation (how strong), L = lightness.

function toHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l }; // grey: no hue at all
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

// one pixel -> a colour family. Black, white, grey, beige, brown and denim
// count as "neutral": in fashion they go with anything
function colorFamily({ h, s, l }) {
  if (s < 0.2 || l < 0.12 || l > 0.92) return "neutral";
  if (h >= 15 && h < 50 && s < 0.5) return "neutral";              // beige, brown, khaki
  if (h >= 195 && h < 235 && s < 0.55 && l < 0.6) return "neutral"; // denim, navy
  if (h < 15 || h >= 345) return "red";
  if (h < 40) return "orange";
  if (h < 70) return "yellow";
  if (h < 160) return "green";
  if (h < 195) return "teal";
  if (h < 255) return "blue";
  if (h < 290) return "purple";
  return "pink";
}

// count the families of all visible pixels, like an array of counters in C, and keep the winner
async function mainColor(photoUrl) {
  const img = await imageFromUrl(photoUrl);
  const canvas = shrinkToCanvas(img, 48); // 48 px is plenty to know the colour, and fast
  const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  const counts = {};
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue; // transparent = background, skip it
    const family = colorFamily(toHsl(data[i], data[i + 1], data[i + 2]));
    counts[family] = (counts[family] || 0) + 1;
    total++;
  }
  if (total === 0) return "";
  // a black hoodie with a small red logo is still a black hoodie:
  // a strong colour wins only if it covers at least 25% of the item
  let best = "neutral";
  for (const family in counts) {
    if (family !== "neutral" && counts[family] > (counts[best] || 0) && counts[family] / total >= 0.25) best = family;
  }
  return best;
}

// items saved before v15 have no colour yet: we work it out once and tell the server
async function fillMissingColors(clothes) {
  for (const item of clothes) {
    if (item.color || !item.photo || !item.photo.endsWith(".png")) continue; // only cut outs (PNG)
    try {
      item.color = await mainColor(item.photo);
      if (item.color) {
        await api("/api/clothes/" + item.id, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ color: item.color })
        });
      }
    } catch (error) {
      console.error("Couldn't read the colour of " + item.name, error);
    }
  }
}

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

// ---------- The smart part: scoring ----------
// Instead of picking at random, every candidate gets POINTS for how well it goes
// with the pieces already chosen. Then we pick at random among the best ones,
// so you still get variety and not the same outfit every morning.

// styles that don't belong together in one outfit
const STYLE_CLASHES = [["sport", "classy"], ["baggy", "fit"]];

function stylesClash(a, b) {
  return STYLE_CLASHES.some(([x, y]) =>
    (a.styles.includes(x) && b.styles.includes(y)) || (a.styles.includes(y) && b.styles.includes(x)));
}

function score(item, slot, chosen) {
  let points = 0;

  // STYLE: pieces that share a style look like one outfit, clashing ones don't
  for (const other of chosen) {
    if (item.styles.some((s) => other.styles.includes(s))) points += 2;
    else if (stylesClash(item, other)) points -= 3;
  }

  // COLOUR (unknown colour = no opinion, 0 points)
  if (item.color && item.color !== "neutral") {
    const strong = chosen.filter((c) => c.color && c.color !== "neutral");
    if (strong.some((c) => c.color === item.color)) points += 1; // same family: blue + blue works
    else if (strong.length > 0) points -= 10;                     // a SECOND strong colour: almost never
  }
  // neutral pieces get 0, not a bonus: an all-neutral outfit is fine, and so is one strong colour

  // SHOES: neutral, or the same colour as the top
  if (slot.type === "shoes" && item.color) {
    const top = chosen.find((c) => c.type === "top");
    if (item.color === "neutral" || (top && top.color === item.color)) points += 1;
  }
  return points;
}

// the best score, and everything within 1 point of it, goes in the hat; then we draw one
function pickBest(pool, slot, chosen) {
  const scored = pool.map((item) => ({ item, points: score(item, slot, chosen) }));
  const best = Math.max(...scored.map((s) => s.points));
  return pickRandom(scored.filter((s) => s.points >= best - 1)).item;
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
    const chosen = currentOutfit.map((p) => p.item).filter(Boolean);
    currentOutfit.push({ slot, item: pickBest(pool, slot, chosen), fallback });
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
  const rest = currentOutfit.filter((p) => p !== piece).map((p) => p.item).filter(Boolean);
  piece.item = pickBest(others, piece.slot, rest); // the new piece must still go with the others
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
    const response = await api("/api/outfits");
    if (response.ok) allOutfits = await response.json();
  } catch (error) {
    // offline: loadClothes already shows the message
  }
}

async function saveOutfit(outfit) {
  const response = await api("/api/outfits", {
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
  await api("/api/outfits/" + boardOutfit.id, { method: "DELETE" });
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
      ctx.shadowColor = "rgba(43, 38, 32, 0.22)"; // soft shadow under each item, like on a table
      ctx.shadowBlur = 36;
      ctx.shadowOffsetY = 14;
      drawContained(ctx, await imageFromUrl(item.photo), x, y, w, h);
      ctx.shadowColor = "transparent";
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

// ---------- Accounts ----------
// The server gives the browser a "ticket" (a cookie) at login. The browser sends it
// by itself with every fetch, so the code below never sees or touches it.

const authForm = document.getElementById("auth-form");
const authSubmit = document.getElementById("auth-submit");
const authSwitch = document.getElementById("auth-switch");
const authHint = document.getElementById("auth-hint");
const authPassword = document.getElementById("auth-password");
let creatingAccount = false; // false = "Log in" mode, true = "Create account" mode

function showAuth() {
  document.body.classList.add("logged-out");
  showView("auth");
}

// the form does two jobs; this switches between them
authSwitch.addEventListener("click", () => {
  creatingAccount = !creatingAccount;
  authSubmit.textContent = creatingAccount ? "Create account" : "Log in";
  authSwitch.textContent = creatingAccount ? "Already have an account? Log in" : "New here? Create an account";
  authHint.hidden = !creatingAccount;
  // tells password managers whether to fill in a saved password or suggest a new one
  authPassword.autocomplete = creatingAccount ? "new-password" : "current-password";
  statusMessage.textContent = "";
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  authSubmit.disabled = true;
  const data = new FormData(authForm);
  try {
    const response = await fetch(creatingAccount ? "/api/register" : "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: data.get("username"), password: data.get("password") })
    });
    const result = await response.json();
    if (!response.ok) {
      statusMessage.textContent = result.error;
      return;
    }
    authForm.reset();
    await enterApp(result);
  } catch (error) {
    statusMessage.textContent = "You're offline, so we can't log you in right now.";
  } finally {
    authSubmit.disabled = false; // runs whether it worked or not
  }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  allClothes = [];
  allOutfits = [];
  showAuth();
});

async function enterApp(user) {
  document.getElementById("account-name").textContent = user.username;
  document.body.classList.remove("logged-out");
  await Promise.all([loadClothes(), loadOutfits(), loadFeatures()]);
  showView("home");
}

async function start() {
  let response;
  try {
    response = await fetch("/api/me"); // "who am I?" The cookie goes along by itself
  } catch (error) {
    statusMessage.textContent = "You're offline. Open the app again when you have internet.";
    return;
  }
  if (response.ok) {
    await enterApp(await response.json());
  } else {
    showAuth();
  }
}

// the AI 3D switch only shows up when the server has an AI key ("Premium" later)
async function loadFeatures() {
  try {
    const features = await (await fetch("/api/features")).json();
    if (!features.ghost) {
      ghostBox.checked = false;
      ghostBox.closest("label").hidden = true;
    }
  } catch (error) {
    ghostBox.checked = false;
    ghostBox.closest("label").hidden = true;
  }
}

// the service worker (sw.js) lets the app open even without internet
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js");
}

start();

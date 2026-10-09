const list = document.getElementById("clothes-list");
const form = document.getElementById("clothing-form");
const statusMessage = document.getElementById("status");

// builds ONE card for ONE item (like a function that fills a struct and returns it)
function createCard(item) {
  const card = document.createElement("li");
  card.className = "card";

  const photo = document.createElement("div");
  photo.className = "card-photo";
  photo.setAttribute("aria-hidden", "true"); // decorative, screen readers skip it
  photo.textContent = item.name.charAt(0).toUpperCase();

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
  const response = await fetch("/api/clothes");
  const clothes = await response.json();

  list.innerHTML = ""; // clear the list before drawing it again

  if (clothes.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Your wardrobe is empty. Add your first item above.";
    list.appendChild(empty);
    return;
  }

  for (const item of clothes) {
    list.appendChild(createCard(item));
  }
}

// runs when the user presses "Add to wardrobe"
form.addEventListener("submit", async (event) => {
  event.preventDefault(); // stop the browser from reloading the page

  const data = new FormData(form);
  const newItem = {
    name: data.get("name"),
    type: data.get("type"),
    styles: data.getAll("styles") // getAll = every checked box, as an array
  };

  const response = await fetch("/api/clothes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(newItem)
  });

  if (response.ok) {
    statusMessage.textContent = newItem.name + " was added to your wardrobe.";
    form.reset();
    loadClothes();
  } else {
    const error = await response.json();
    statusMessage.textContent = "Could not add the item: " + error.error;
  }
});

loadClothes();

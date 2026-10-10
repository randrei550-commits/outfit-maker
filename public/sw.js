// Service worker = a small helper the browser runs in the background for our app.
// Its job here: keep a copy of the app's files, so the app still opens without internet.

const CACHE = "outfit-maker-v7";
const APP_FILES = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

// 1. installed for the first time: save a copy of the app's files
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

// 2. a new version takes over: throw away copies from old versions
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// 3. every request: try the internet FIRST (so you always see your newest code),
//    and only if that fails, use the saved copy
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isOurFile = url.origin === self.location.origin && !url.pathname.startsWith("/api/");
  if (event.request.method !== "GET" || !isOurFile) return; // clothes data, weather, AI: no copies

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

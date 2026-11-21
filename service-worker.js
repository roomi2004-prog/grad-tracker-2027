const CACHE_NAME = "grad-tracker-2027-pwa-v3";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon.svg"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never intercept localhost dev preview, GitHub REST API, ntfy push endpoints, Apps Script webhooks, or /api/
  if (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "api.github.com" ||
    url.hostname === "ntfy.sh" ||
    url.hostname.endsWith(".ntfy.sh") ||
    url.hostname === "script.google.com" ||
    url.hostname === "script.googleusercontent.com" ||
    url.pathname.startsWith("/api/")
  ) {
    return;
  }

  // Strictly network-first (no-store, never stale cache when online) for state.json, deadlines.ics, and HTML
  const isLiveData =
    url.pathname.endsWith("state.json") ||
    url.pathname.endsWith("deadlines.ics");
  const isDynamic =
    isLiveData ||
    request.mode === "navigate" ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith(".html");

  if (isDynamic) {
    event.respondWith(
      fetch(request, { cache: "no-store" })
        .then((response) => {
          if (response && response.ok && !isLiveData) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => (isLiveData ? Response.error() : caches.match(request, { ignoreSearch: true })))
    );
    return;
  }

  // Stale-while-revalidate for icons, manifest, CDN scripts & fonts
  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && (response.ok || response.type === "opaque")) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});

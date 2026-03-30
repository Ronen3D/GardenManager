// Garden Manager Service Worker
// Caches all app assets for full offline support

const CACHE_NAME = 'garden-manager-v2';

// Install: cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache the HTML entry point
      await cache.add('./index.html');

      // Discover and cache all built assets by fetching the HTML and parsing asset URLs
      try {
        const response = await fetch('./index.html');
        const html = await response.text();

        // Extract all asset references from the built HTML
        const assetUrls = [];
        const hrefMatches = html.matchAll(/(?:href|src)="(\.[^"]+)"/g);
        for (const match of hrefMatches) {
          assetUrls.push(match[1]);
        }

        // Also cache known static assets
        const staticAssets = [
          './favicon.svg',
          './icon.png',
          './fonts/Rubik-VariableFont.ttf',
          './manifest.json'
        ];

        const allUrls = [...new Set([...assetUrls, ...staticAssets])];

        // Cache each asset, ignoring failures for optional ones
        await Promise.allSettled(
          allUrls.map((url) => cache.add(url))
        );
      } catch (e) {
        console.warn('SW: Could not cache some assets during install:', e);
      }
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first for assets (hashed filenames), network-first for HTML
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin requests
  if (url.origin !== location.origin) return;

  // For navigation requests (HTML), use network-first so updates are picked up
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // For all other assets: cache-first (Vite hashed filenames are immutable)
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).then((response) => {
        // Cache successful responses for future offline use
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});

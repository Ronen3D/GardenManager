// Garden Manager Service Worker
// Caches all app assets for full offline support

const CACHE_NAME = 'garden-manager-v3';

// Synthetic same-origin cache key used to hand a Web-Share-Target file off to
// the page. It is NOT a real asset — see the fetch handler guards below.
const SHARED_IMPORT_KEY = './__shared_import__';

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
          './favicon.png',
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

  // Web Share Target: Android shares the exported file as a POST to
  // `<scope>share-target` (see manifest.json `share_target`). There is no
  // backend (static GitHub Pages), so the SW must catch the POST, stash the
  // file text under a synthetic cache key, and redirect the client to the app
  // with a flag it picks up on load. The redirect is the LAST awaited step, so
  // the stash is guaranteed complete before the page reads it (no race).
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(
      (async () => {
        try {
          const formData = await event.request.formData();
          const file = formData.get('file');
          const text = file && typeof file !== 'string' ? await file.text() : '';
          const cache = await caches.open(CACHE_NAME);
          await cache.put(
            new Request(SHARED_IMPORT_KEY),
            new Response(text, { headers: { 'Content-Type': 'text/plain' } })
          );
        } catch (e) {
          // Swallow — the client treats a missing/empty stash as a no-op.
          console.warn('SW: share-target stash failed:', e);
        }
        return Response.redirect(`${self.registration.scope}?share-target=pending`, 303);
      })()
    );
    return;
  }

  // The synthetic share-import key is never a real network asset — never let
  // the cache-first asset branch below serve or (re-)cache it.
  if (url.pathname.endsWith('/__shared_import__')) return;

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

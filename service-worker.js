// Cache version. The server rewrites the placeholder below with a stamp derived
// from the modification times of everything under static/, widgets/ and
// templates/, so ANY edit to the app changes these cache names — which makes
// the activate handler drop the previous caches. Nobody has to remember to bump
// a number by hand; a forgotten bump used to mean the browser quietly kept
// serving the old build with no obvious way out.
//
// Served raw (not through the Flask route) this stays the literal string, which
// is still valid — it just means the version never changes.
const BUILD = '__BUILD__';
const CACHE_NAME = 'beamer-plus-' + BUILD;
const STATIC_CACHE_NAME = 'beamer-plus-static-' + BUILD;
const DYNAMIC_CACHE_NAME = 'beamer-plus-dynamic-' + BUILD;

// The app shell — just enough to boot the presenter offline. These are the real
// Flask route / entry-point assets; everything they pull in (the ES-module tree
// under /static/js, CSS @imports, fonts) is cached on first use by the runtime
// fetch handler below, so it never needs listing here. Third-party libraries
// are vendored under /static/vendor, so there are no CDN dependencies.
const STATIC_ASSETS = [
  '/',
  '/manifest.json',
  '/static/css/app.css',
  '/static/js/main.js',
  '/static/vendor/socket.io.min.js',
  '/static/vendor/jszip.min.js',
  '/static/vendor/marked.min.js',
  '/static/vendor/qrcode.min.js',
  '/static/vendor/model-viewer.min.js',
  '/static/vendor/pdfjs/pdf.min.mjs',
  '/static/vendor/pdfjs/pdf.worker.min.mjs',
  '/static/icons/icon-192x192.png',
  '/static/icons/icon-512x512.png'
];

// API endpoints that stream large payloads — never cache these. The ZIP
// endpoints would add ~40MB per presentation load; /api/zip-asset/ streams
// per-slide media (videos, 3D models) that would otherwise accumulate in the
// dynamic cache without bound. Matched by prefix.
const UNCACHED_API_PREFIXES = [
  '/api/presentation/current',
  '/api/demo-zip',
  '/api/zip-asset/'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  console.log('[Service Worker] Installing...');
  
  event.waitUntil(
    caches.open(STATIC_CACHE_NAME)
      .then((cache) => {
        console.log('[Service Worker] Caching static assets');
        // Cache assets one by one to avoid failing the entire install
        return Promise.allSettled(
          STATIC_ASSETS.map(url => 
            cache.add(url).catch(err => {
              console.warn(`[Service Worker] Failed to cache ${url}:`, err.message);
              return null;
            })
          )
        );
      })
      .then(() => {
        console.log('[Service Worker] Static assets cached, skipping waiting');
        return self.skipWaiting();
      })
      .catch(err => {
        console.error('[Service Worker] Installation failed:', err);
        throw err;
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Activating...');
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((cacheName) => {
            return cacheName !== STATIC_CACHE_NAME && 
                   cacheName !== DYNAMIC_CACHE_NAME;
          })
          .map((cacheName) => {
            console.log('[Service Worker] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          })
      );
    }).then(() => {
      console.log('[Service Worker] Activation complete');
      return self.clients.claim();
    })
  );
});

// Fetch event - network-first for API calls, cache-first for static assets
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests. Cross-origin assets (e.g. the Cloudflare
  // analytics beacon) and non-http schemes (chrome-extension://, etc.) must go
  // straight to the network: proxying third-party hosts causes spurious
  // "Fetch failed" errors, and the Cache API rejects unsupported schemes with
  // "Request scheme '…' is unsupported" when cache.put() is attempted.
  if (url.origin !== self.location.origin) {
    return;
  }

  // Skip WebSocket connections and Socket.IO polling
  if (url.pathname.includes('/socket.io/') ||
      request.url.includes('transport=polling') ||
      request.url.includes('transport=websocket')) {
    return;
  }

  // The Cache API only supports GET. Let non-GET requests (session/survey
  // creation, responses, etc.) go straight to the network — intercepting them
  // just risks a `cache.put` throwing 'Request method POST is unsupported'.
  if (request.method !== 'GET') {
    return;
  }

  // Network-first strategy for HTML navigation requests — ensures the page
  // markup is always fresh even when a cached copy exists.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.status === 200) {
            const clone = response.clone();
            caches.open(STATIC_CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then(r => r || caches.match('/')))
    );
    return;
  }

  // Network-first strategy for API calls
  if (url.pathname.startsWith('/api/')) {
    // cache.put() throws on non-GET requests, and the big ZIP downloads
    // shouldn't be cached at all.
    const cacheable = request.method === 'GET' &&
                      !UNCACHED_API_PREFIXES.some(p => url.pathname.startsWith(p));
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Only cache successful responses
          if (cacheable && response.status === 200) {
            const responseClone = response.clone();
            caches.open(DYNAMIC_CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }

          return response;
        })
        .catch(() => {
          // Try to serve from cache if network fails
          return caches.match(request);
        })
    );
    return;
  }
  
  // The app's own code is network-first: it changes with every edit, and a
  // cache-first copy of it survives a server restart *and* a reload, so the
  // browser would keep running a stale build with no obvious way out. The
  // cached copy is still written and still served when the network is gone, so
  // offline use is unaffected. Vendored libraries and media stay cache-first
  // below — they're large and only change when their path does.
  //
  // /widgets/ counts as app code too: a widget's HTML carries both its
  // behaviour and the `widget-schema` block the editor builds its properties
  // panel from, so a stale copy shows the presenter the wrong fields.
  if (url.pathname.startsWith('/static/js/') ||
      url.pathname.startsWith('/static/css/') ||
      url.pathname.startsWith('/widgets/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type !== 'error') {
            const clone = response.clone();
            caches.open(STATIC_CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Cache-first strategy for everything else static (vendored libs, icons, media)
  event.respondWith(
    caches.match(request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        
        // If not in cache, fetch from network and cache it
        return fetch(request)
          .then((response) => {
            // Don't cache non-successful responses
            if (!response || response.status !== 200 || response.type === 'error') {
              return response;
            }
            
            // Clone the response
            const responseClone = response.clone();
            
            // Determine which cache to use
            const cacheName = STATIC_ASSETS.includes(url.pathname)
                             ? STATIC_CACHE_NAME
                             : DYNAMIC_CACHE_NAME;
            
            caches.open(cacheName).then((cache) => {
              cache.put(request, responseClone);
            });
            
            return response;
          })
          .catch((err) => {
            console.error('[Service Worker] Fetch failed:', err);
            
            // Fall back to the cached presenter shell for navigations.
            if (request.mode === 'navigate') {
              return caches.match('/');
            }
            
            throw err;
          });
      })
  );
});

// Handle messages from clients
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => caches.delete(cacheName))
        );
      }).then(() => {
        return self.registration.unregister();
      }).then(() => {
        event.ports[0].postMessage({ success: true });
      })
    );
  }
});

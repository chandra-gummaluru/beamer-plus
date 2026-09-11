/* Beamer+ — deliberately NOT a caching service worker.
 *
 * Beamer+ is edited constantly and run from a machine in the room, so a cached
 * copy of the app is all cost and no benefit: it survives a server restart and
 * a reload, and leaves the browser quietly running an old build with no obvious
 * way out. Everything is served straight from the network instead (the Flask
 * routes send no-store; see server/core.py).
 *
 * This file still exists, and is still registered, for one reason: a service
 * worker already installed in someone's browser stays there until it is
 * unregistered. Deleting this file would NOT remove it — it would leave the old
 * caching worker in charge forever. So this is a tombstone: it takes over from
 * whatever was registered before, deletes every cache, unregisters itself, and
 * reloads any open page so it is running live code from that moment on.
 *
 * It has no fetch handler at all. A service worker without one is transparent:
 * requests go to the network exactly as if no worker existed.
 *
 * Once you're confident no browser is still carrying the old worker, this file
 * and its registration in templates/index.html can both be deleted.
 */

self.addEventListener('install', () => {
  // Don't sit in "waiting" behind the worker being replaced.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 1. Drop every cache this origin has, whatever named them.
    try {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    } catch (err) {
      console.warn('[sw] could not clear caches:', err);
    }

    // 2. Remove this worker. Pages currently open keep their controller until
    //    they navigate, which is why they are reloaded below.
    try { await self.registration.unregister(); } catch (err) {
      console.warn('[sw] could not unregister:', err);
    }

    // 3. Reload open pages so they stop running whatever the old worker served
    //    them and pick everything up fresh from the network.
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        if ('navigate' in client) client.navigate(client.url);
      }
    } catch (err) {
      console.warn('[sw] could not reload clients:', err);
    }
  })());
});

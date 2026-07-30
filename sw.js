// WordSteps service worker — 缓存应用外壳，运行时缓存词库，支持离线使用。
const CACHE = 'wordsteps-v59';
const SHELL = [
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './favicon.ico',
  './icon-192.png',
  './icon-512.png',
  './icon.svg',
  './books/manifest.js',
  './books/en_defs.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () {
      return self.skipWaiting();
    })
  );
});

// 响应客户端消息（skip-waiting 强制激活）
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'skip-waiting') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
    .then(function () {
      // 通知所有打开的客户端：新版本已激活，建议刷新
      return self.clients.matchAll().then(function (clients) {
        clients.forEach(function (client) {
          client.postMessage({ type: 'sw-updated', version: CACHE });
        });
      });
    })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  // 跨域资源（如发音音频）直接放行，不缓存
  if (url.origin !== self.location.origin) return;

  // 页面导航：缓存优先（立即渲染），后台拉取最新版本
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) {
          // 后台更新缓存，不阻塞页面渲染
          fetch(req).then(function (res) {
            if (res && res.ok) {
              var cp = res.clone();
              caches.open(CACHE).then(function (c) { c.put(req, cp); });
            }
          }).catch(function () {});
          return hit;
        }
        // 首次无缓存时走网络
        return fetch(req).then(function (res) {
          var cp = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, cp); });
          return res;
        }).catch(function () {
          return caches.match('./index.html');
        });
      })
    );
    return;
  }

  // 静态资源与词库：缓存优先，缺失时网络拉取并写入缓存
  e.respondWith(
    caches.match(req).then(function (r) {
      if (r) return r;
      return fetch(req).then(function (res) {
        if (res && res.ok) {
          var cp = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, cp); });
        }
        return res;
      }).catch(function () {
        return new Response("(offline)", { status: 503 });
      });
    })
  );
});

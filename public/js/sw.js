// Agape service worker: push notifications only. Pages are never cached here,
// so private details are not stored on the device.
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  var title = data.title || 'Agape';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'You have a new notification. Open Agape to see it.',
    data: { url: data.url || '/inbox' },
    tag: data.url || 'agape',
    renotify: true,
    requireInteraction: !!data.urgent,
    icon: '/static/img/icon.svg',
  }));
});
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/inbox';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if ('focus' in list[i]) { list[i].navigate(url); return list[i].focus(); }
    }
    return self.clients.openWindow(url);
  }));
});

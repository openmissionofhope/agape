// Full pages: push notification setup. Loaded after common.js on non-emergency pages.
(function () {
  'use strict';
  var box = document.querySelector('[data-push]');
  if (!box) return;
  var status = box.querySelector('[data-push-status]');
  var enable = box.querySelector('[data-push-enable]');
  var test = box.querySelector('[data-push-test]');
  var csrf = box.getAttribute('data-csrf');
  var key = box.getAttribute('data-key');
  function say(t) { status.textContent = t; }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    say('This browser does not support push notifications. You will still see everything in your Agape inbox.');
    return;
  }
  function urlB64ToUint8Array(b64) {
    var padding = '='.repeat((4 - (b64.length % 4)) % 4);
    var raw = atob((b64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.message || 'failed'); return j; }); });
  }
  navigator.serviceWorker.register('/sw.js').then(function (reg) {
    return reg.pushManager.getSubscription().then(function (sub) {
      if (Notification.permission === 'denied') { say('Notifications are blocked for Agape in this browser’s settings.'); return; }
      enable.hidden = false;
      if (sub) { say('Push notifications are on for this device.'); test.hidden = false; enable.textContent = 'Refresh this device’s push registration'; }
      else say('Push notifications are off for this device.');
      enable.addEventListener('click', function () {
        say('Asking your browser…');
        Notification.requestPermission().then(function (p) {
          if (p !== 'granted') { say('Permission was not given. You will still see everything in your inbox.'); return; }
          return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(key) }).then(function (s) {
            var j = s.toJSON();
            return post('/push/subscribe', { endpoint: j.endpoint, keys: j.keys, label: navigator.platform || 'This device' }).then(function () {
              say('Push notifications are on for this device. Use “Check this device” to test.'); test.hidden = false;
            });
          });
        }).catch(function (e) { say('Could not turn on push: ' + e.message); });
      });
      test.addEventListener('click', function () {
        post('/push/test').then(function (j) { say(j.message); }, function (e) { say('Test failed: ' + e.message); });
      });
    });
  }).catch(function () { say('Push could not start in this browser.'); });
})();

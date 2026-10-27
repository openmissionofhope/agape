// Emergency form: explicit send states. A request is shown as received only
// when the server has confirmed it; offline or failed sends never look sent.
(function () {
  'use strict';
  var form = document.querySelector('[data-emergency-form]');
  if (!form || !window.fetch || !window.FormData) return;
  var box = form.querySelector('[data-send-status]');
  var button = form.querySelector('button[type="submit"]');
  var sending = false;
  function show(kind, text) {
    box.hidden = false;
    box.className = 'send-status' + (kind === 'sending' ? ' sending' : '');
    box.textContent = text;
  }
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (sending) return;
    var data = new FormData(form);
    if (!data.getAll('needs').length) { show('error', 'Choose what you need first.'); return; }
    if (!String(data.get('location_text') || '').trim() && !data.get('lat')) {
      show('error', 'Tell us where the emergency is: type the address or a landmark, or share your location.');
      return;
    }
    if (navigator.onLine === false) {
      show('error', 'NOT SENT — this device is offline. Call 911 if you can. Your answers are still here; press Send again when you have a connection.');
      return;
    }
    sending = true;
    button.disabled = true;
    show('sending', 'Sending… not received yet.');
    var controller = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, 20000);
    fetch(form.action, {
      method: 'POST', body: new URLSearchParams(data), credentials: 'same-origin',
      headers: { Accept: 'application/json' }, signal: controller ? controller.signal : undefined,
    }).then(function (res) {
      return res.json().then(function (j) { return { ok: res.ok, j: j }; }, function () { return { ok: false, j: {} }; });
    }).then(function (r) {
      clearTimeout(timer);
      if (r.ok && r.j.ok && r.j.url) {
        show('sending', 'Received by Agape. Opening your request…');
        window.location.assign(r.j.url);
        return;
      }
      sending = false; button.disabled = false;
      show('error', 'NOT SENT — ' + (r.j.message || 'Agape could not accept the request.') + ' Call 911 if you can.');
    }, function () {
      clearTimeout(timer);
      sending = false; button.disabled = false;
      show('error', 'NOT CONFIRMED — the connection failed, so we cannot tell whether Agape received your request. Call 911 if you can. Press Send again: it will not create a duplicate.');
    });
  });
})();

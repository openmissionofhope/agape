// One-time, consent-based location reading. Never watches position.
(function () {
  'use strict';
  if (!('geolocation' in navigator)) return;
  function describe(pos) {
    var c = pos.coords;
    var t = new Date(pos.timestamp || Date.now()).toLocaleTimeString();
    return c.latitude.toFixed(5) + ', ' + c.longitude.toFixed(5) + ' — accurate to about ' + Math.round(c.accuracy) + ' m, read at ' + t + '.';
  }
  function errorText(err) {
    if (err.code === 1) return 'Location permission was not given. Type the address or a landmark instead.';
    if (err.code === 3) return 'Finding your location took too long. Type the address or a landmark instead.';
    return 'Your location could not be found. Type the address or a landmark instead.';
  }
  var opts = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 };

  Array.prototype.forEach.call(document.querySelectorAll('[data-geo]'), function (box) {
    var wrap = box.classList.contains('geo-device') ? box : box.querySelector('.geo-device');
    if (!wrap) return;
    wrap.hidden = false;
    var btn = wrap.querySelector('[data-geo-button]');
    var status = wrap.querySelector('[data-geo-status]');
    var f = function (n) { return wrap.querySelector('input[name="' + n + '"]'); };
    var form = box.closest('form');
    function clear(msg) {
      ['lat', 'lng', 'accuracy', 'captured_at'].forEach(function (n) { f(n).value = ''; });
      status.textContent = msg || 'Location cleared.';
      btn.textContent = 'Share my current location';
    }
    if (f('lat').value) status.textContent = 'A location was shared earlier: ' + f('lat').value + ', ' + f('lng').value + '.';
    btn.addEventListener('click', function () {
      if (f('lat').value) { clear(); return; }
      status.textContent = 'Finding your location…';
      navigator.geolocation.getCurrentPosition(function (pos) {
        f('lat').value = pos.coords.latitude; f('lng').value = pos.coords.longitude;
        f('accuracy').value = Math.round(pos.coords.accuracy); f('captured_at').value = pos.timestamp || Date.now();
        var warn = pos.coords.accuracy > 500 ? ' This is imprecise: please also type the address or a landmark.' : ' If this is wrong, press the button to remove it and type the address.';
        status.textContent = 'Location shared: ' + describe(pos) + warn;
        btn.textContent = 'Remove this location';
      }, function (err) { status.textContent = errorText(err); }, opts);
    });
    if (form) {
      Array.prototype.forEach.call(form.querySelectorAll('input[name="at_incident"]'), function (r) {
        r.addEventListener('change', function () {
          var away = form.querySelector('input[name="at_incident"][value="no"]').checked;
          btn.disabled = away;
          if (away && f('lat').value) clear('Your device location was removed, because you are not at the emergency. Type the emergency’s address.');
        });
      });
    }
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-geo-read]'), function (box) {
    box.hidden = false;
    var status = box.querySelector('[data-geo-read-status]');
    box.querySelector('[data-geo-read-button]').addEventListener('click', function () {
      status.textContent = 'Finding your location…';
      navigator.geolocation.getCurrentPosition(function (pos) {
        status.textContent = 'You are near ' + describe(pos) + ' Read the street address from a sign if you can; coordinates are a backup.';
      }, function (err) { status.textContent = errorText(err).replace(' instead', ''); }, opts);
    });
  });
})();

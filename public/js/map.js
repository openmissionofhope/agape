// Optional map of approximate request areas. The list view has the same data.
(function () {
  'use strict';
  var el = document.getElementById('map');
  if (!el || !window.L) return;
  fetch(el.getAttribute('data-src'), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
    var map = L.map(el).setView([d.center.lat, d.center.lng], 11);
    // OpenStreetMap's tile policy asks for a Referer; send only our origin, never the page path.
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 15, attribution: '© OpenStreetMap contributors', referrerPolicy: 'strict-origin-when-cross-origin' }).addTo(map);
    L.circle([d.center.lat, d.center.lng], { radius: d.radiusM, color: '#184f95', weight: 1, fill: false }).addTo(map);
    d.points.forEach(function (p) {
      var c = L.circle([p.lat, p.lng], { radius: 700, color: p.kind === 'emergency' ? '#b3261e' : '#184f95', weight: 2, fillOpacity: 0.2 }).addTo(map);
      var a = document.createElement('a'); a.href = p.url; a.textContent = p.label;
      c.bindPopup(a);
    });
  }).catch(function () { el.textContent = 'The map could not be loaded. Use the list instead.'; });
})();

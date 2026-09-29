(function () {
  var params = new URLSearchParams(window.location.search);
  var userId = params.get('user_id') || '';

  var els = {
    astroName: document.getElementById('astro-name'),
    connectSubtext: document.getElementById('connect-subtext'),
    regularPrice: document.getElementById('regular-price'),
    emergencyPrice: document.getElementById('emergency-price'),
    ctaBtn: document.getElementById('cta-btn'),
    ctaLabel: document.getElementById('cta-label'),
    screenEmergency: document.getElementById('screen-emergency'),
    screenWaitlist: document.getElementById('screen-waitlist'),
    ctaDeck: document.getElementById('cta-deck'),
    waitlistNote: document.getElementById('waitlist-astro-note'),
    homeBtn: document.getElementById('home-btn'),
  };

  var state = { astroName: '', emergencyCpm: 0, found: false };

  function logEvent(eventName, meta) {
    var body = JSON.stringify({ user_id: userId, event_name: eventName, meta: meta || {} });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/event', new Blob([body], { type: 'application/json' }));
    } else {
      fetch('/api/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
    }
  }

  function render(data) {
    state.astroName = data.astro_name;
    state.emergencyCpm = data.emergency_cpm;
    state.found = data.found;

    els.astroName.textContent = data.astro_name;
    els.connectSubtext.textContent = "They're offline right now, but we'll try calling them for you.";
    els.regularPrice.innerHTML = '₹' + data.astro_cpm + '<span class="unit">/min</span>';
    els.emergencyPrice.innerHTML = '₹' + data.emergency_cpm + '<span class="unit">/min</span>';
    els.ctaLabel.textContent = 'Try Emergency Session @ ₹' + data.emergency_cpm + '/min';
    els.ctaBtn.disabled = false;

    logEvent(data.found ? 'astro_emergency_view' : 'astro_emergency_view_fallback', {
      astro_name: data.astro_name,
      emergency_cpm: data.emergency_cpm,
    });
  }

  function goToWaitlist() {
    els.screenEmergency.classList.remove('active');
    els.screenWaitlist.classList.add('active');
    els.ctaDeck.style.display = 'none';
    if (state.astroName) {
      els.waitlistNote.textContent = "You'll be first in line to reach " + state.astroName + '.';
    }
    logEvent('waitlist_view', { astro_name: state.astroName });
  }

  els.ctaBtn.addEventListener('click', function () {
    els.ctaBtn.disabled = true;
    logEvent('start_chat_click', { emergency_cpm: state.emergencyCpm, astro_name: state.astroName });

    fetch('/api/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId }),
    })
      .catch(function () {})
      .finally(goToWaitlist);
  });

  els.homeBtn.addEventListener('click', function () {
    logEvent('return_home_click', { astro_name: state.astroName });
    // Best-effort: same back-navigation convention as the header's back
    // button. If this page is opened inside the AstroLokal app's WebView,
    // history.back() returns to the screen that opened this page (the home
    // tab in the common case).
    history.back();
  });

  fetch('/api/lookup?user_id=' + encodeURIComponent(userId))
    .then(function (res) { return res.json(); })
    .then(render)
    .catch(function () {
      render({ found: false, astro_name: 'Our Astrologer', astro_cpm: 20, emergency_cpm: 30 });
    });
})();

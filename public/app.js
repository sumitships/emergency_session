(function () {
  var params = new URLSearchParams(window.location.search);
  var userId = params.get('user_id') || '';

  // Same back-navigation pattern used on bhagya-score. Inside the
  // AstroLokal app's React Native WebView, firing the deeplink would stack
  // a NEW Home screen on top of this WebView instead of actually going
  // back — so the postMessage bridge (which the native side pops the
  // WebView for directly) is always tried first. The deeplink is only a
  // fallback for when this page is opened outside the app WebView (plain
  // browser, no bridge injected).
  var DEEPLINK_SCHEME = 'astrolokal://BottomTabs?screen=Home';
  var PAGE_NAME = 'emergency_astro_connect';

  function sendBackAction() {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ action: 'GO_BACK' }));
      return true;
    }
    return false;
  }

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
    backBtn: document.getElementById('back-btn'),
    homeBtn: document.getElementById('home-btn'),
    avatarIcon: document.getElementById('avatar-icon'),
    astroPhoto: document.getElementById('astro-photo'),
    astroFallback: document.getElementById('astro-fallback'),
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

  // Fired immediately, independent of whether /api/lookup ever resolves —
  // so a page visit is always recorded even if that request fails or is slow.
  logEvent('page_view', { page: PAGE_NAME, in_webview: !!window.ReactNativeWebView });

  function showFallbackAvatar() {
    els.avatarIcon.classList.remove('has-photo');
    els.astroPhoto.hidden = true;
    els.astroFallback.hidden = false;
  }

  function setAvatarPhoto(imageUrl, astroName) {
    if (!imageUrl) {
      showFallbackAvatar();
      return;
    }
    els.astroPhoto.onload = function () {
      els.avatarIcon.classList.add('has-photo');
      els.astroFallback.hidden = true;
      els.astroPhoto.hidden = false;
    };
    els.astroPhoto.onerror = showFallbackAvatar;
    els.astroPhoto.alt = astroName || '';
    els.astroPhoto.src = imageUrl;
  }

  function render(data) {
    state.astroName = data.astro_name;
    state.emergencyCpm = data.emergency_cpm;
    state.found = data.found;

    els.astroName.textContent = data.astro_name;
    els.connectSubtext.textContent = "They're offline right now, but we'll try calling them for you.";
    setAvatarPhoto(data.astro_image_url, data.astro_name);
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

  els.backBtn.addEventListener('click', function () {
    logEvent('back_click', { astro_name: state.astroName });
    if (sendBackAction()) return;
    window.location.href = DEEPLINK_SCHEME + '&source=' + PAGE_NAME + '_back';
  });

  els.homeBtn.addEventListener('click', function () {
    logEvent('return_home_click', { astro_name: state.astroName });
    if (sendBackAction()) return;
    window.location.href =
      DEEPLINK_SCHEME + '&source=' + PAGE_NAME + '_home&user_id=' + encodeURIComponent(userId);
  });

  fetch('/api/lookup?user_id=' + encodeURIComponent(userId))
    .then(function (res) { return res.json(); })
    .then(render)
    .catch(function () {
      render({ found: false, astro_name: 'Our Astrologer', astro_cpm: 20, emergency_cpm: 30 });
    });
})();

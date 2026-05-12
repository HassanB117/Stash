(function () {
  const nativeFetch = window.fetch.bind(window);
  let csrfToken = null;
  let csrfPromise = null;

  async function initCsrf() {
    if (csrfToken) return csrfToken;
    if (!csrfPromise) {
      csrfPromise = nativeFetch('/api/csrf', { credentials: 'same-origin' })
        .then(async (res) => {
          if (!res.ok) throw new Error('csrf unavailable');
          const data = await res.json();
          csrfToken = data.csrfToken || null;
          return csrfToken;
        })
        .catch(() => null)
        .finally(() => {
          csrfPromise = null;
        });
    }
    return csrfPromise;
  }

  async function csrfFetch(input, init) {
    const options = init ? { ...init } : {};
    const method = String(options.method || (input && input.method) || 'GET').toUpperCase();
    if (method !== 'GET') {
      const token = await initCsrf();
      const headers = new Headers(options.headers || (input instanceof Request ? input.headers : undefined));
      if (token) headers.set('X-CSRF-Token', token);
      options.headers = headers;
      options.credentials = options.credentials || 'same-origin';
    }
    return nativeFetch(input, options);
  }

  window.initCsrf = initCsrf;
  window.csrfFetch = csrfFetch;
  window.fetch = csrfFetch;

  // Populate any [data-app-version] elements from /api/version so the UI
  // stays in lockstep with package.json without per-page hardcoded strings.
  function applyAppVersion() {
    const slots = document.querySelectorAll('[data-app-version]');
    if (!slots.length) return;
    nativeFetch('/api/version', { credentials: 'same-origin' })
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (!data || !data.version) return;
        slots.forEach((el) => { el.textContent = 'v' + data.version; });
      })
      .catch(() => {});
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyAppVersion);
  } else {
    applyAppVersion();
  }

  // ── Custom video player ───────────────────────────────────────────────
  window.buildVideoPlayer = function (src) {
    var wrap = document.createElement('div');
    wrap.className = 'vplayer';

    var vid = document.createElement('video');
    vid.className = 'vplayer-video';
    vid.src = src;
    vid.preload = 'auto';
    vid.playsInline = true;

    var pulse = document.createElement('div');
    pulse.className = 'vplayer-pulse';
    pulse.innerHTML = '<span>▶</span>';

    var bar = document.createElement('div');
    bar.className = 'vplayer-bar';

    var btnPlay = document.createElement('button');
    btnPlay.className = 'vplayer-btn';
    btnPlay.type = 'button';
    btnPlay.setAttribute('aria-label', 'Play video');
    btnPlay.textContent = '▶';

    var timeEl = document.createElement('span');
    timeEl.className = 'vplayer-time';
    timeEl.textContent = '0:00 / 0:00';

    var seekWrap = document.createElement('div');
    seekWrap.className = 'vplayer-seek';
    var seekBuf  = document.createElement('div');
    seekBuf.className  = 'vplayer-seek-buf';
    var seekFill = document.createElement('div');
    seekFill.className = 'vplayer-seek-fill';
    seekWrap.appendChild(seekBuf);
    seekWrap.appendChild(seekFill);

    var btnMute = document.createElement('button');
    btnMute.className = 'vplayer-btn';
    btnMute.type = 'button';
    btnMute.setAttribute('aria-label', 'Mute video');
    btnMute.textContent = 'VOL';

    var btnFs = document.createElement('button');
    btnFs.className = 'vplayer-btn';
    btnFs.type = 'button';
    btnFs.setAttribute('aria-label', 'Enter fullscreen');
    btnFs.textContent = '⛶';

    bar.appendChild(btnPlay);
    bar.appendChild(timeEl);
    bar.appendChild(seekWrap);
    bar.appendChild(btnMute);
    bar.appendChild(btnFs);
    wrap.appendChild(vid);
    wrap.appendChild(pulse);
    wrap.appendChild(bar);

    var hideTimer = null;
    var seeking = false;

    function fmt(s) {
      s = Math.floor(s || 0);
      var h = Math.floor(s / 3600);
      var m = Math.floor((s % 3600) / 60);
      var r = s % 60;
      if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
      return m + ':' + String(r).padStart(2, '0');
    }

    function reveal() {
      wrap.classList.remove('vp-hidden');
      clearTimeout(hideTimer);
      if (!vid.paused && !vid.ended) {
        hideTimer = setTimeout(function () { wrap.classList.add('vp-hidden'); }, 3000);
      }
    }

    function syncState() {
      var playing = !vid.paused && !vid.ended;
      btnPlay.textContent = playing ? '⏸' : '▶';
      btnPlay.setAttribute('aria-label', playing ? 'Pause video' : 'Play video');
      pulse.querySelector('span').textContent = playing ? '⏸' : '▶';
      wrap.classList.toggle('vp-playing', playing);
      if (!playing) { clearTimeout(hideTimer); wrap.classList.remove('vp-hidden'); }
      else reveal();
    }

    function updateProgress() {
      var dur = vid.duration || 0;
      var cur = vid.currentTime;
      var pct = dur ? (cur / dur * 100) : 0;
      seekFill.style.width = pct + '%';
      timeEl.textContent = fmt(cur) + ' / ' + fmt(dur);
      if (dur && vid.buffered.length) {
        seekBuf.style.width = (vid.buffered.end(vid.buffered.length - 1) / dur * 100) + '%';
      }
    }

    function doSeek(e) {
      var r   = seekWrap.getBoundingClientRect();
      var x   = e.clientX !== undefined ? e.clientX : (e.touches ? e.touches[0].clientX : 0);
      var pct = Math.max(0, Math.min(1, (x - r.left) / r.width));
      vid.currentTime = pct * (vid.duration || 0);
      updateProgress();
    }

    seekWrap.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      seekWrap.setPointerCapture(e.pointerId);
      seeking = true;
      doSeek(e);
      reveal();
    });
    seekWrap.addEventListener('pointermove', function (e) {
      if (seeking) { doSeek(e); }
    });
    seekWrap.addEventListener('pointerup', function () { seeking = false; });

    function togglePlay(e) {
      if (e) e.stopPropagation();
      reveal();
      if (vid.paused || vid.ended) vid.play().catch(function () {});
      else vid.pause();
    }

    pulse.addEventListener('click', function (e) { e.stopPropagation(); togglePlay(); });
    vid.addEventListener('click', togglePlay);
    btnPlay.addEventListener('click', function (e) { e.stopPropagation(); togglePlay(); });

    btnMute.addEventListener('click', function (e) {
      e.stopPropagation();
      vid.muted = !vid.muted;
      btnMute.textContent = vid.muted ? 'MUTE' : 'VOL';
      btnMute.setAttribute('aria-label', vid.muted ? 'Unmute video' : 'Mute video');
      reveal();
    });

    btnFs.addEventListener('click', function (e) {
      e.stopPropagation();
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else if (wrap.requestFullscreen) {
        wrap.requestFullscreen();
      } else if (vid.webkitEnterFullscreen) {
        vid.webkitEnterFullscreen();
      }
    });

    vid.addEventListener('play',           syncState);
    vid.addEventListener('pause',          syncState);
    vid.addEventListener('ended',          syncState);
    vid.addEventListener('timeupdate',     updateProgress);
    vid.addEventListener('loadedmetadata', updateProgress);

    wrap.addEventListener('mousemove',  function () { reveal(); });
    wrap.addEventListener('touchstart', function () { reveal(); }, { passive: true });

    vid.play().catch(function () {});
    return wrap;
  };
})();

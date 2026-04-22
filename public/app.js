(function () {
  let allCaptures = {};
  let currentFilter = 'All';
  let currentItem = null;
  let currentDrillGame = null;
  let favorites = new Set();
  let siteUrl = '';
  let metaCache = {};
  let recentItems = [];
  let recentVisibleCount = 0;
  let lightboxQueue = [];
  let lightboxIndex = -1;
  let platformFilter = 'All';
  let gameMeta = {};

  const RECENT_PAGE_SIZE = 120;

  function $(id) { return document.getElementById(id); }

  const grid            = $('grid');
  const filtersEl       = $('filters');
  const lightbox        = $('lightbox');
  const lbContent       = $('lbContent');
  const lbMeta          = $('lbMeta');
  const shareModal      = $('shareModal');
  const settingsModal   = $('settingsModal');
  const shareUrlEl      = $('shareUrl');
  const recentMoreBtn   = $('recentMoreBtn');
  const recentShownCount = $('recentShownCount');

  // ── Tab switching ──────────────────────────────────────────────────────
  var tabRecent    = $('tabRecent');
  var tabGames     = $('tabGames');
  var tabStarred   = $('tabStarred');
  var panelRecent  = $('panelRecent');
  var panelGames   = $('panelGames');
  var panelStarred = $('panelStarred');

  function setTab(name) {
    tabRecent.classList.toggle('active', name === 'recent');
    tabGames.classList.toggle('active', name === 'games');
    tabStarred.classList.toggle('active', name === 'starred');
    panelRecent.classList.toggle('active', name === 'recent');
    panelGames.classList.toggle('active', name === 'games');
    panelStarred.classList.toggle('active', name === 'starred');
    // Sync mobile bottom tabs
    var mtr = $('mTabRecent');
    if (mtr) {
      mtr.classList.toggle('active', name === 'recent');
      $('mTabGames').classList.toggle('active', name === 'games');
      $('mTabStarred').classList.toggle('active', name === 'starred');
    }
    if (name === 'games') showLibrary();
    if (name === 'starred') renderStarredGrid();
  }

  tabRecent.addEventListener('click', function () { setTab('recent'); });
  tabGames.addEventListener('click', function () { setTab('games'); });
  tabStarred.addEventListener('click', function () { setTab('starred'); });
  if (recentMoreBtn) {
    recentMoreBtn.addEventListener('click', function () {
      recentVisibleCount = Math.min(recentVisibleCount + RECENT_PAGE_SIZE, recentItems.length);
      renderRecentGrid();
    });
  }

  // ── Drilldown helpers ─────────────────────────────────────────────────
  var gamesLibrary  = $('gamesLibrary');
  var gameDrilldown = $('gameDrilldown');
  var drilldownGrid = $('drilldownGrid');

  function showLibrary() {
    gamesLibrary.style.display  = 'flex';
    gameDrilldown.style.display = 'none';
    currentDrillGame = null;
  }

  function showDrilldown(game) {
    currentDrillGame = game;
    gamesLibrary.style.display  = 'none';
    gameDrilldown.style.display = 'flex';
    var dn = (gameMeta[game] && gameMeta[game].displayName) || game;
    $('drilldownTitle').textContent = dn.toUpperCase();
    var items = allCaptures[game] || [];
    $('drilldownCount').textContent = items.length + ' CAPTURES';
    renderDrilldownGrid(game, items);
  }

  $('backToGames').addEventListener('click', showLibrary);

  // ── Config & captures ─────────────────────────────────────────────────
  async function loadConfig() {
    const res = await fetch('/api/config');
    if (res.status === 401) { window.location.href = '/login'; return; }
    const cfg = await res.json();
    siteUrl = cfg.siteUrl || '';
    $('hello').textContent = cfg.username + "'s archive";
    $('folderLabel').textContent = cfg.capturesPath;
    $('folderInput').value = cfg.capturesPath;
  }

  async function loadFavorites() {
    const res = await fetch('/api/favorites');
    if (res.status === 401) { window.location.href = '/login'; return; }
    favorites = new Set(await res.json());
  }

  async function loadCaptures() {
    const res = await fetch('/api/captures');
    if (res.status === 401) { window.location.href = '/login'; return; }
    allCaptures = await res.json();
    gameMeta = {};
    Object.keys(allCaptures).forEach(function (key) { gameMeta[key] = parsePlatform(key); });
    renderFilters();
    renderGrid();
    updateCounts();
    renderPlatformPills();
    renderGamesGrid(Object.keys(allCaptures).sort());
  }

  function updateCounts() {
    var games = Object.keys(allCaptures);
    var total = 0;
    games.forEach(function (g) { total += allCaptures[g].length; });
    $('recentCount').textContent = total;
    $('gamesCount').textContent  = games.length;
    $('starredCount').textContent = favorites.size;
    // Mobile tab badges
    var mbr = $('mBadgeRecent');
    if (mbr) {
      mbr.textContent = total || '';
      $('mBadgeGames').textContent   = games.length || '';
      $('mBadgeStarred').textContent = favorites.size || '';
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  function parsePlatform(folderName) {
    var idx = folderName.lastIndexOf(' - ');
    if (idx === -1) return { displayName: folderName, platform: null };
    return { displayName: folderName.slice(0, idx), platform: folderName.slice(idx + 3) };
  }

  function renderPlatformPills() {
    var pillsEl = $('platformPills');
    if (!pillsEl) return;
    var platforms = [];
    Object.values(gameMeta).forEach(function (m) {
      if (m.platform && platforms.indexOf(m.platform) === -1) platforms.push(m.platform);
    });
    platforms.sort();
    if (platforms.length === 0) { pillsEl.style.display = 'none'; return; }
    pillsEl.style.display = '';
    var tags = ['All'].concat(platforms);
    pillsEl.innerHTML = tags.map(function (p) {
      return '<button class="platform-pill' + (p === platformFilter ? ' active' : '') +
             '" data-platform="' + escapeHtml(p) + '">' + escapeHtml(p) + '</button>';
    }).join('');
    pillsEl.querySelectorAll('.platform-pill').forEach(function (btn) {
      btn.addEventListener('click', function () {
        platformFilter = btn.dataset.platform;
        renderPlatformPills();
        renderGamesGrid(Object.keys(allCaptures).sort());
      });
    });
  }

  // ── Filters (hidden, kept for compat) ────────────────────────────────
  function renderFilters() {
    var games = Object.keys(allCaptures).sort();
    var tags  = ['All'].concat(games);
    filtersEl.innerHTML = tags.map(function (t) {
      return '<span class="filter ' + (t === currentFilter ? 'active' : '') +
             '" data-game="' + escapeHtml(t) + '">' + escapeHtml(t) + '</span>';
    }).join('');
    filtersEl.querySelectorAll('.filter').forEach(function (el) {
      el.addEventListener('click', function () {
        currentFilter = el.dataset.game;
        renderFilters();
        renderGrid();
      });
    });
  }

  // ── Recent grid ───────────────────────────────────────────────────────
  function buildRecentItems() {
    var items = [];
    var games = Object.keys(allCaptures).sort();
    games.forEach(function (g) {
      allCaptures[g].forEach(function (f) { items.push(Object.assign({}, f, { game: g })); });
    });
    items.sort(function (a, b) { return b.mtime - a.mtime; });
    return items;
  }

  function renderRecentGrid() {
    if (recentItems.length === 0) {
      grid.innerHTML = '<div class="empty">// NO CAPTURES DETECTED</div>';
      if (recentShownCount) recentShownCount.textContent = '';
      if (recentMoreBtn) recentMoreBtn.style.display = 'none';
      return;
    }

    var visible = recentItems.slice(0, recentVisibleCount);
    grid.innerHTML = visible.map(function (item, i) {
      return renderTileHTML(item, i);
    }).join('');

    attachTileEvents(grid, visible);

    if (recentShownCount) {
      recentShownCount.textContent = visible.length + ' / ' + recentItems.length + ' SHOWN';
    }
    if (recentMoreBtn) {
      var moreLeft = recentVisibleCount < recentItems.length;
      recentMoreBtn.style.display = moreLeft ? '' : 'none';
      recentMoreBtn.disabled = !moreLeft;
      recentMoreBtn.textContent = moreLeft ? 'LOAD MORE' : 'ALL LOADED';
    }
  }

  function renderGrid() {
    recentItems = buildRecentItems();
    recentVisibleCount = Math.min(RECENT_PAGE_SIZE, recentItems.length);
    renderRecentGrid();
  }

  // ── Starred grid ──────────────────────────────────────────────────────
  function renderStarredGrid() {
    var items = [];
    var games = Object.keys(allCaptures).sort();
    games.forEach(function (g) {
      allCaptures[g].forEach(function (f) {
        if (favorites.has(f.path)) items.push(Object.assign({}, f, { game: g }));
      });
    });
    items.sort(function (a, b) { return b.mtime - a.mtime; });
    var sg = $('starredGrid');
    if (items.length === 0) {
      sg.innerHTML = '<div class="empty">// NO STARRED CAPTURES</div>';
      return;
    }
    sg.innerHTML = items.map(function (item, i) { return renderTileHTML(item, i); }).join('');
    attachTileEvents(sg, items);
  }

  // ── Drilldown grid ────────────────────────────────────────────────────
  function renderDrilldownGrid(game, rawItems) {
    var items = rawItems.map(function (f) { return Object.assign({}, f, { game: game }); });
    if (items.length === 0) {
      drilldownGrid.innerHTML = '<div class="empty">// NO CAPTURES</div>';
      return;
    }
    drilldownGrid.innerHTML = items.map(function (item, i) {
      return renderTileHTML(item, i);
    }).join('');
    attachTileEvents(drilldownGrid, items);
  }

  // ── Shared tile renderer ──────────────────────────────────────────────
  function renderTileHTML(item, i) {
    var fileUrl    = '/files/'   + encodeURIComponent(item.path);
    var thumbUrl   = '/thumb/'   + encodeURIComponent(item.path);
    var previewUrl = '/preview/' + encodeURIComponent(item.path);
    var date       = formatDate(item.mtime);
    var starred    = favorites.has(item.path);
    var media      = item.type === 'video'
      ? '<video poster="' + thumbUrl + '" muted loop preload="none" playsinline data-src="' + previewUrl + '" data-file="' + fileUrl + '"></video><div class="badge" data-dur-badge>▶ CLIP</div>'
      : '<img src="' + thumbUrl + '" alt="' + escapeHtml(item.name) + '" loading="lazy" data-fallback="' + fileUrl + '">';
    return '<div class="tile" data-index="' + i + '">' +
      '<button class="tile-star' + (starred ? ' starred' : '') + '" data-path="' + escapeHtml(item.path) + '">' + (starred ? '★' : '☆') + '</button>' +
      media +
      '<div class="tile-label">' +
        '<span>' + escapeHtml(((gameMeta[item.game] && gameMeta[item.game].displayName) || item.game).toUpperCase().slice(0, 18)) + '</span>' +
        '<span class="tile-date">' + date + '</span>' +
      '</div>' +
    '</div>';
  }

  function attachTileEvents(container, items) {
    container.querySelectorAll('.tile').forEach(function (tile) {
      var idx  = parseInt(tile.dataset.index);
      var item = items[idx];

      var starBtn = tile.querySelector('.tile-star');
      starBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleFavorite(item.path);
      });

      var img = tile.querySelector('img[data-fallback]');
      if (img) {
        img.addEventListener('error', function () {
          if (this.src !== this.dataset.fallback) this.src = this.dataset.fallback;
        });
      }

      if (item.type === 'video') {
        var video = tile.querySelector('video');
        tile.addEventListener('mouseenter', function () {
          if (video && !video.src) {
            video.src = video.dataset.src || '';
            if (video.src) video.load();
          }
          if (video) video.play().catch(function () {});
        });
        tile.addEventListener('mouseleave', function () {
          if (!video) return;
          video.pause();
          try { video.currentTime = 0; } catch (err) {}
        });
      }
      tile.addEventListener('click', function () { openLightbox(item, items, idx); });
    });
  }


  async function toggleFavorite(filePath) {
    try {
      var res = await fetch('/api/favorites/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: filePath }),
      });
      var data = await res.json();
      if (!res.ok) return;
      if (data.starred) favorites.add(filePath);
      else favorites.delete(filePath);
      document.querySelectorAll('.tile-star').forEach(function (btn) {
        if (btn.dataset.path === filePath) {
          btn.textContent = data.starred ? '★' : '☆';
          btn.classList.toggle('starred', data.starred);
        }
      });
      if (currentItem && currentItem.path === filePath) {
        var lbStar = $('lbStar');
        lbStar.textContent = data.starred ? '★ STARRED' : '☆ STAR';
        lbStar.classList.toggle('starred', data.starred);
      }
      updateCounts();
      if (panelStarred.classList.contains('active')) renderStarredGrid();
    } catch {}
  }

  function formatDate(mtime) {
    var d = new Date(mtime);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // ── Games library grid ────────────────────────────────────────────────
  var gamesGridEl    = $('gamesGrid');
  var gamesSearchEl  = $('gamesSearch');
  var gamesCountEl   = $('gamesCountLabel');

  gamesSearchEl.addEventListener('input', function () {
    var q     = gamesSearchEl.value.trim().toLowerCase();
    var games = Object.keys(allCaptures).sort().filter(function (g) {
      var dn = (gameMeta[g] && gameMeta[g].displayName) || g;
      return dn.toLowerCase().includes(q) || g.toLowerCase().includes(q);
    });
    gamesCountEl.textContent = q ? games.length + ' RESULTS' : '';
    renderGamesGrid(games);
  });

  function renderGamesGrid(games) {
    if (platformFilter !== 'All') {
      games = games.filter(function (g) { return gameMeta[g] && gameMeta[g].platform === platformFilter; });
    }
    if (games.length === 0) {
      gamesGridEl.innerHTML = '<div class="empty" style="grid-column:1/-1">// NO GAMES FOUND</div>';
      return;
    }
    gamesGridEl.innerHTML = games.map(function (game) {
      var displayName = (gameMeta[game] && gameMeta[game].displayName) || game;
      var items   = allCaptures[game] || [];
      var count   = items.length;
      var hasClip = items.some(function (i) { return i.type === 'video'; });
      var latest  = items.reduce(function (a, b) { return b.mtime > a.mtime ? b : a; }, items[0] || { mtime: 0 });
      var date    = latest.mtime ? formatDate(latest.mtime) : '';

      // Use actual thumbnail if available
      var artItem = items.find(function (i) { return i.type === 'image'; }) || items[0];
      var thumbUrl = artItem ? '/thumb/' + encodeURIComponent(artItem.path) : null;

      var artHtml;
      if (thumbUrl) {
        var safeThumb = thumbUrl.replace(/'/g, '%27');
        artHtml = '<div class="game-card-art" style="background-image:url(\'' + safeThumb + '\');background-size:cover;background-position:center">' +
          '<div style="position:absolute;inset:0;background:linear-gradient(transparent 30%,rgba(0,0,0,0.75))"></div>' +
          '</div>';
      } else {
        var n   = game.length;
        var ang = (n * 17) % 180;
        var sl  = (n * 13) % 90 + 20;
        var a1  = n * 7 % 8;       var b1 = n * 11 % 60 + 20;
        var a2  = n * 3 % 15 + 10; var b2 = n * 7 % 40 + 40;
        var a3  = n * 9 % 20 + 20; var b3 = n * 5 % 30 + 10;
        var a4  = n * 11 % 20 + 35;var b4 = n * 13 % 50 + 30;
        var a5  = n * 7 % 15 + 50; var b5 = n * 11 % 25 + 5;
        var a6  = n * 13 % 15 + 65;var b6 = n * 7 % 40 + 30;
        var a7  = n * 5 % 15 + 78; var b7 = n * 9 % 35 + 20;
        var a8  = 95;               var b8 = n * 11 % 40 + 35;
        var hue   = (n * 47 + game.charCodeAt(0) * 3) % 360;
        var sil = 'polygon(0 100%,' + a1 + '% ' + b1 + '%,' + a2 + '% ' + b2 + '%,' +
                  a3 + '% ' + b3 + '%,' + a4 + '% ' + b4 + '%,' + a5 + '% ' + b5 + '%,' +
                  a6 + '% ' + b6 + '%,' + a7 + '% ' + b7 + '%,' + a8 + '% ' + b8 + '%,100% 100%)';
        artHtml = '<div class="game-card-art" style="background:linear-gradient(' + ang + 'deg,hsl(' + hue + ',45%,18%),hsl(' + hue + ',30%,8%))">' +
          '<div style="position:absolute;inset:0;background:repeating-linear-gradient(' + sl + 'deg,hsla(' + hue + ',60%,50%,0.06) 0px,hsla(' + hue + ',60%,50%,0.06) 1px,transparent 1px,transparent ' + (6 + n % 6) + 'px)"></div>' +
          '<div style="position:absolute;bottom:0;left:0;right:0;height:55%;background:linear-gradient(transparent,hsl(' + hue + ',40%,6%))"></div>' +
          '<div style="position:absolute;bottom:0;left:5%;right:5%;height:40%;background:hsl(' + hue + ',30%,10%);clip-path:' + sil + '"></div>' +
          '</div>';
      }

      return '<div class="game-card" data-game="' + escapeHtml(game) + '">' +
        artHtml +
        '<div class="game-card-info">' +
          '<div class="game-card-name">' + escapeHtml(displayName) + '</div>' +
          '<div class="game-card-meta">' +
            '<span>' + count + (count === 1 ? ' CAPTURE' : ' CAPTURES') + (hasClip ? ' · CLIPS' : '') + '</span>' +
            '<span>' + date + '</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    gamesGridEl.querySelectorAll('.game-card').forEach(function (card) {
      card.addEventListener('click', function () {
        showDrilldown(card.dataset.game);
      });
    });
  }

  // ── Custom video player ───────────────────────────────────────────────
  function buildVideoPlayer(src) {
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
    btnMute.textContent = 'VOL';

    var btnFs = document.createElement('button');
    btnFs.className = 'vplayer-btn';
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
      return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
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
  }

  // ── Lightbox ──────────────────────────────────────────────────────────
  function updateNavArrows() {
    var prevBtn = $('lbPrev');
    var nextBtn = $('lbNext');
    if (!prevBtn || !nextBtn) return;
    if (lightboxQueue.length <= 1) { prevBtn.hidden = true; nextBtn.hidden = true; return; }
    prevBtn.hidden = lightboxIndex <= 0;
    nextBtn.hidden = lightboxIndex >= lightboxQueue.length - 1;
  }

  function navigateLightbox(delta) {
    var newIdx = lightboxIndex + delta;
    if (newIdx < 0 || newIdx >= lightboxQueue.length) return;
    openLightbox(lightboxQueue[newIdx], lightboxQueue, newIdx);
  }

  function openLightbox(item, queue, idx) {
    currentItem = item;
    lightboxQueue = queue || [];
    lightboxIndex = (idx !== undefined) ? idx : -1;

    var fileUrl = '/files/' + encodeURIComponent(item.path);
    lbContent.innerHTML = '';
    if (item.type === 'video') {
      lbContent.appendChild(buildVideoPlayer(fileUrl));
    } else {
      var img = document.createElement('img');
      img.src = fileUrl;
      img.alt = escapeHtml(item.name);
      lbContent.appendChild(img);
    }

    var displayGame = (gameMeta[item.game] && gameMeta[item.game].displayName) || item.game;
    $('lbGame').textContent = displayGame.toUpperCase();
    $('lbName').textContent = item.name;
    $('lbDate').textContent = formatDate(item.mtime);

    var starred = favorites.has(item.path);
    $('lbStar').textContent = starred ? '★ STARRED' : '☆ STAR';
    $('lbStar').classList.toggle('starred', starred);

    $('lbDetail').style.display = 'none';
    $('lbMetaSep2').style.display = 'none';
    fetchFileMeta(item.path);

    updateNavArrows();
    lbMeta.style.display = 'flex';
    lightbox.classList.add('open');
  }

  function closeLightbox() {
    var vid = lbContent.querySelector('.vplayer-video');
    if (vid) { vid.pause(); vid.src = ''; }
    if (document.fullscreenElement) document.exitFullscreen();
    lightbox.classList.remove('open');
    lbContent.innerHTML = '';
    lbMeta.style.display = 'none';
    $('lbDetail').style.display = 'none';
    $('lbMetaSep2').style.display = 'none';
    currentItem = null;
    lightboxQueue = [];
    lightboxIndex = -1;
  }

  async function fetchFileMeta(filePath) {
    if (metaCache[filePath] === undefined) {
      try {
        var res = await fetch('/api/file-meta?path=' + encodeURIComponent(filePath));
        metaCache[filePath] = res.ok ? await res.json() : null;
      } catch { metaCache[filePath] = null; }
    }
    var m = metaCache[filePath];
    if (!m || !currentItem || currentItem.path !== filePath) return;
    var parts = [m.size];
    if (m.dimensions) parts.push(m.dimensions);
    if (m.duration) parts.push(m.duration);
    $('lbDetail').textContent = parts.join(' · ');
    $('lbDetail').style.display = '';
    $('lbMetaSep2').style.display = '';
  }

  $('lbClose').addEventListener('click', closeLightbox);
  $('lbPrev').addEventListener('click', function (e) { e.stopPropagation(); navigateLightbox(-1); });
  $('lbNext').addEventListener('click', function (e) { e.stopPropagation(); navigateLightbox(+1); });
  lightbox.addEventListener('click', function (e) {
    if (e.target === lightbox) closeLightbox();
  });

  $('lbStar').addEventListener('click', function () {
    if (!currentItem) return;
    toggleFavorite(currentItem.path);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (shareModal.classList.contains('open'))         shareModal.classList.remove('open');
      else if (settingsModal.classList.contains('open')) settingsModal.classList.remove('open');
      else if (lightbox.classList.contains('open'))      closeLightbox();
      else if (currentDrillGame)                         showLibrary();
      return;
    }
    // Video keyboard shortcuts (space/k=play, ←/→=seek ±5s, m=mute, f=fullscreen)
    // For images: ←/→ navigate between items
    if (!lightbox.classList.contains('open') || shareModal.classList.contains('open')) return;
    var activeTag = document.activeElement && document.activeElement.tagName;
    if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;
    var vid = lbContent.querySelector('.vplayer-video');
    if (!vid) {
      if (e.key === 'ArrowLeft')  { e.preventDefault(); navigateLightbox(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); navigateLightbox(+1); }
      return;
    }
    if (e.key === ' ' || e.key === 'k') {
      e.preventDefault();
      if (vid.paused || vid.ended) vid.play().catch(function () {}); else vid.pause();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      vid.currentTime = Math.max(0, vid.currentTime - 5);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      vid.currentTime = Math.min(vid.duration || 0, vid.currentTime + 5);
    } else if (e.key === 'm' || e.key === 'M') {
      vid.muted = !vid.muted;
    } else if (e.key === 'f' || e.key === 'F') {
      var player = lbContent.querySelector('.vplayer');
      if (!player) return;
      if (document.fullscreenElement) document.exitFullscreen();
      else if (player.requestFullscreen) player.requestFullscreen();
    }
  });

  // ── Share ──────────────────────────────────────────────────────────────
  $('lbShare').addEventListener('click', async function () {
    if (!currentItem) return;
    try {
      var res = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: currentItem.path }),
      });
      var data = await res.json();
      if (!res.ok) { alert(data.error || 'failed'); return; }
      shareUrlEl.value = (siteUrl || window.location.origin) + data.url;
      shareModal.classList.add('open');
    } catch { alert('share failed'); }
  });

  $('copyBtn').addEventListener('click', function () {
    shareUrlEl.select();
    navigator.clipboard.writeText(shareUrlEl.value).then(function () {
      $('copyBtn').textContent = '✓ COPIED';
      setTimeout(function () { $('copyBtn').textContent = '⊕ COPY'; }, 1500);
    });
  });

  $('shareClose').addEventListener('click', function () { shareModal.classList.remove('open'); });
  shareModal.addEventListener('click', function (e) { if (e.target === shareModal) shareModal.classList.remove('open'); });

  // ── Settings ───────────────────────────────────────────────────────────
  $('settingsBtn').addEventListener('click', function () {
    $('folderMsg').textContent = '';
    $('passMsg').textContent = '';
    $('currentPass').value = '';
    $('newPass').value = '';
    settingsModal.classList.add('open');
  });
  $('settingsClose').addEventListener('click', function () { settingsModal.classList.remove('open'); });
  settingsModal.addEventListener('click', function (e) { if (e.target === settingsModal) settingsModal.classList.remove('open'); });

  $('saveFolderBtn').addEventListener('click', async function () {
    var newPath = $('folderInput').value.trim();
    var msg = $('folderMsg');
    msg.textContent = '';
    try {
      var res = await fetch('/api/config/path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capturesPath: newPath }),
      });
      var data = await res.json();
      if (res.ok) {
        msg.textContent = '✓ PATH UPDATED';
        msg.className = 'settings-msg ok';
        await loadConfig();
        await loadCaptures();
      } else {
        msg.textContent = '✗ ' + (data.error || 'failed');
        msg.className = 'settings-msg bad';
      }
    } catch {
      msg.textContent = '✗ NETWORK ERROR';
      msg.className = 'settings-msg bad';
    }
  });

  $('savePassBtn').addEventListener('click', async function () {
    var cur = $('currentPass').value;
    var nw  = $('newPass').value;
    var msg = $('passMsg');
    msg.textContent = '';
    try {
      var res = await fetch('/api/config/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: cur, newPassword: nw }),
      });
      var data = await res.json();
      if (res.ok) {
        msg.textContent = '✓ PASSWORD UPDATED';
        msg.className = 'settings-msg ok';
        $('currentPass').value = '';
        $('newPass').value = '';
      } else {
        msg.textContent = '✗ ' + (data.error || 'failed');
        msg.className = 'settings-msg bad';
      }
    } catch {
      msg.textContent = '✗ NETWORK ERROR';
      msg.className = 'settings-msg bad';
    }
  });

  $('logoutBtn').addEventListener('click', async function () {
    await fetch('/logout', { method: 'POST' });
    window.location.href = '/login';
  });

  // ── Mobile tab bar ────────────────────────────────────────────────────
  var mTabRecentEl = $('mTabRecent');
  if (mTabRecentEl) {
    mTabRecentEl.addEventListener('click',  function () { setTab('recent'); });
    $('mTabGames').addEventListener('click',   function () { setTab('games'); });
    $('mTabStarred').addEventListener('click', function () { setTab('starred'); });
  }

  // ── Init ───────────────────────────────────────────────────────────────
  (async function () {
    await Promise.all([loadConfig(), loadFavorites()]);
    await loadCaptures();

    setInterval(async function () {
      try {
        var res = await fetch('/api/captures');
        if (!res.ok) return;
        var newCaptures = await res.json();
        var oldTotal = Object.values(allCaptures).reduce(function (s, a) { return s + a.length; }, 0);
        var newTotal = Object.values(newCaptures).reduce(function (s, a) { return s + a.length; }, 0);
        if (newTotal !== oldTotal || Object.keys(newCaptures).length !== Object.keys(allCaptures).length) {
          allCaptures = newCaptures;
          gameMeta = {};
          Object.keys(allCaptures).forEach(function (key) { gameMeta[key] = parsePlatform(key); });
          renderFilters();
          renderGrid();
          updateCounts();
          renderPlatformPills();
          renderGamesGrid(Object.keys(allCaptures).sort());
        }
      } catch {}
    }, 30000);
  })();
})();

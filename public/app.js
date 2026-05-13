(function () {
  let allCaptures = {};
  let currentItem = null;
  let currentDrillGame = null;
  let favorites = new Set();
  let siteUrl = '';
  let metaCache = {};
  let recentItems = [];
  let recentTotal = 0;
  let renderedRecentCount = 0;
  let recentLoading = false;
  let lightboxQueue = [];
  let lightboxIndex = -1;
  let platformFilter = 'All';
  let gameMeta = {};
  let capturesVersion = '';
  let refreshInFlight = null;

  // Lazily fetch duration for video tile badges when they scroll into view
  var durObserver = typeof IntersectionObserver !== 'undefined' && new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var badge = entry.target;
      durObserver.unobserve(badge);
      var p = badge.dataset.durPath;
      if (!p) return;
      if (metaCache[p] !== undefined) {
        var mc = metaCache[p];
        if (mc && mc.duration) setDurationBadge(badge, mc.duration);
        return;
      }
      fetch('/api/file-meta?path=' + encodeURIComponent(p))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (m) { metaCache[p] = m; if (m && m.duration) setDurationBadge(badge, m.duration); })
        .catch(function () {});
    });
  }, { rootMargin: '200px' });

  // Lazily set background-image on game card art when it scrolls into view
  var artObserver = typeof IntersectionObserver !== 'undefined' && new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var el = entry.target;
      artObserver.unobserve(el);
      var bg = el.dataset.bg;
      if (bg) {
        el.style.backgroundImage = "url('" + bg + "')";
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
        delete el.dataset.bg;
      }
    });
  }, { rootMargin: '200px' });

  const RECENT_PAGE_SIZE = 120;

  function $(id) { return document.getElementById(id); }
  function withRefreshParam(url, force) {
    return force ? url + (url.indexOf('?') === -1 ? '?' : '&') + 'refresh=1' : url;
  }

  function setDurationBadge(badge, label) {
    var text = badge && badge.querySelector('.badge-text');
    if (text) text.textContent = label;
    else if (badge) badge.textContent = '▶ ' + label;
  }

  const grid            = $('grid');
  const lightbox        = $('lightbox');
  const lbContent       = $('lbContent');
  const lbMeta          = $('lbMeta');
  const shareModal      = $('shareModal');
  const settingsModal   = $('settingsModal');
  const shareUrlEl      = $('shareUrl');
  const recentMoreBtn   = $('recentMoreBtn');
  const recentShownCount = $('recentShownCount');
  const refreshBtn      = $('refreshBtn');
  const syncStatus      = $('syncStatus');

  // ── Tab switching ──────────────────────────────────────────────────────
  var tabRecent    = $('tabRecent');
  var tabGames     = $('tabGames');
  var tabStarred   = $('tabStarred');
  var panelRecent  = $('panelRecent');
  var panelGames   = $('panelGames');
  var panelStarred = $('panelStarred');

  function setTab(name) {
    [
      { key: 'recent', tab: tabRecent, panel: panelRecent, mobile: $('mTabRecent') },
      { key: 'games', tab: tabGames, panel: panelGames, mobile: $('mTabGames') },
      { key: 'starred', tab: tabStarred, panel: panelStarred, mobile: $('mTabStarred') },
    ].forEach(function (entry) {
      var active = name === entry.key;
      entry.tab.classList.toggle('active', active);
      entry.tab.setAttribute('aria-selected', active ? 'true' : 'false');
      entry.panel.classList.toggle('active', active);
      entry.panel.hidden = !active;
      if (entry.mobile) {
        entry.mobile.classList.toggle('active', active);
        entry.mobile.setAttribute('aria-selected', active ? 'true' : 'false');
      }
    });
    if (name === 'games') showLibrary();
    else currentDrillGame = null;
    if (name === 'starred') renderStarredGrid();
  }

  tabRecent.addEventListener('click', function () { setTab('recent'); });
  tabGames.addEventListener('click', function () { setTab('games'); });
  tabStarred.addEventListener('click', function () { setTab('starred'); });
  if (recentMoreBtn) {
    recentMoreBtn.addEventListener('click', function () { loadRecentNextPage(); });
  }

  // ── Drilldown helpers ─────────────────────────────────────────────────
  var gamesLibrary  = $('gamesLibrary');
  var gameDrilldown = $('gameDrilldown');
  var drilldownGrid = $('drilldownGrid');

  function showLibrary() {
    gamesLibrary.hidden = false;
    gameDrilldown.hidden = true;
    currentDrillGame = null;
    if (gamesSearchEl) gamesSearchEl.focus({ preventScroll: true });
  }

  function showDrilldown(game) {
    currentDrillGame = game;
    gamesLibrary.hidden = true;
    gameDrilldown.hidden = false;
    var dn = (gameMeta[game] && gameMeta[game].displayName) || game;
    $('drilldownTitle').textContent = dn.toUpperCase();
    var items = allCaptures[game] || [];
    $('drilldownCount').textContent = items.length + ' CAPTURES';
    renderDrilldownGrid(game, items);
    $('backToGames').focus({ preventScroll: true });
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
    $('siteUrlInput').value = cfg.siteUrl || '';
    populateSecuritySection(cfg);
  }

  function populateSecuritySection(cfg) {
    const tpSel = $('trustProxySelect');
    const tpHops = $('trustProxyHops');
    const csSel = $('cookieSecureSelect');
    const notice = $('securityEnvNotice');
    const saveBtn = $('saveSecurityBtn');
    if (!tpSel || !csSel) return;

    const tpEnv = !!cfg.trustProxyManagedByEnv;
    const csEnv = !!cfg.cookieSecureManagedByEnv;

    const tp = cfg.trustProxy;
    if (tp === true) { tpSel.value = 'on'; tpHops.style.display = 'none'; }
    else if (Number.isInteger(tp) && tp >= 1) { tpSel.value = 'hops'; tpHops.value = tp; tpHops.style.display = ''; }
    else { tpSel.value = 'off'; tpHops.style.display = 'none'; }

    const cs = cfg.cookieSecure;
    csSel.value = cs === true ? 'true' : cs === false ? 'false' : 'auto';

    tpSel.disabled = tpEnv;
    tpHops.disabled = tpEnv;
    csSel.disabled = csEnv;
    saveBtn.disabled = tpEnv && csEnv;

    const managed = [];
    if (tpEnv) managed.push('TRUST_PROXY');
    if (csEnv) managed.push('SESSION_COOKIE_SECURE');
    if (managed.length) {
      notice.textContent = '⚠ managed by env: ' + managed.join(', ');
      notice.className = 'settings-msg bad';
      notice.style.display = '';
    } else {
      notice.style.display = 'none';
    }
  }

  async function loadFavorites() {
    const res = await fetch('/api/favorites');
    if (res.status === 401) { window.location.href = '/login'; return; }
    favorites = new Set(await res.json());
  }

  async function loadCaptures(force) {
    const res = await fetch(withRefreshParam('/api/captures', force));
    if (res.status === 401) { window.location.href = '/login'; return; }
    allCaptures = await res.json();
    gameMeta = {};
    Object.keys(allCaptures).forEach(function (key) { gameMeta[key] = parsePlatform(key); });
    pruneFavoritesToLoadedCaptures();
    updateCounts();
    renderPlatformPills();
    renderGamesGrid(Object.keys(allCaptures).sort());
  }

  async function fetchRecentPage(offset, force) {
    try {
      const res = await fetch(withRefreshParam('/api/captures/recent?offset=' + offset + '&limit=' + RECENT_PAGE_SIZE, force));
      if (res.status === 401) { window.location.href = '/login'; return null; }
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  async function loadRecent(reset, force) {
    if (recentLoading) return;
    recentLoading = true;
    updateRefreshButton();
    updateRecentMoreButton();
    try {
      // Fetch before mutating so a failed reset doesn't wipe state out from
      // under the DOM. On success we mutate `recentItems` in place so existing
      // tile click handlers (which close over the array) keep seeing it.
      const offset = reset ? 0 : recentItems.length;
      const page = await fetchRecentPage(offset, force);
      if (!page) return;
      if (reset) {
        recentItems.length = 0;
        renderedRecentCount = 0;
      }
      recentTotal = page.total;
      for (let i = 0; i < page.items.length; i++) recentItems.push(page.items[i]);
      renderRecentGrid({ append: !reset });
      updateCounts();
    } finally {
      recentLoading = false;
      updateRecentMoreButton();
      updateRefreshButton();
    }
  }

  function loadRecentNextPage() {
    if (recentItems.length >= recentTotal) return;
    loadRecent(false, false);
  }

  function versionKey(v) {
    return v.total + ':' + v.games + ':' + v.maxMtime;
  }

  async function fetchCapturesVersion(force) {
    try {
      const res = await fetch(withRefreshParam('/api/captures/version', force));
      if (!res.ok) return '';
      return versionKey(await res.json());
    } catch { return ''; }
  }

  function updateCounts() {
    var games = Object.keys(allCaptures);
    var total = 0;
    games.forEach(function (g) { total += allCaptures[g].length; });
    // Prefer server-reported Recent total once we've loaded a page; falls back to allCaptures tally
    var recentCount = recentTotal || total;
    $('recentCount').textContent = recentCount;
    $('gamesCount').textContent  = games.length;
    $('starredCount').textContent = favorites.size;
    // Mobile tab badges
    var mbr = $('mBadgeRecent');
    if (mbr) {
      mbr.textContent = recentCount || '';
      $('mBadgeGames').textContent   = games.length || '';
      $('mBadgeStarred').textContent = favorites.size || '';
    }
  }

  function pruneFavoritesToLoadedCaptures() {
    if (favorites.size === 0) return;
    var valid = new Set();
    Object.keys(allCaptures).forEach(function (game) {
      allCaptures[game].forEach(function (item) {
        if (favorites.has(item.path)) valid.add(item.path);
      });
    });
    favorites = valid;
  }

  function syncActivePanelsAfterReload() {
    if (panelStarred.classList.contains('active')) renderStarredGrid();
    if (!currentDrillGame) return;
    if (!allCaptures[currentDrillGame] || allCaptures[currentDrillGame].length === 0) {
      showLibrary();
      return;
    }
    showDrilldown(currentDrillGame);
  }

  function updateRefreshButton() {
    if (!refreshBtn) return;
    var busy = !!refreshInFlight || recentLoading;
    refreshBtn.disabled = busy;
    refreshBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
    var label = refreshBtn.querySelector('.btn-label');
    if (label) label.textContent = busy ? 'SYNCING...' : 'REFRESH';
    if (syncStatus) syncStatus.textContent = busy ? 'SYNCING' : 'LIVE';
  }

  async function refreshLibrary(force) {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async function () {
      updateRefreshButton();
      await Promise.all([loadCaptures(force), loadRecent(true, force)]);
      capturesVersion = await fetchCapturesVersion(force);
      syncActivePanelsAfterReload();
    })().finally(function () {
      refreshInFlight = null;
      updateRefreshButton();
    });
    return refreshInFlight;
  }

  function openDialog(el, focusTarget) {
    if (!el) return;
    var wasOpen = el.classList.contains('open');
    if (!wasOpen) el._returnFocus = document.activeElement;
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
    if (wasOpen) return;
    setTimeout(function () {
      var target = focusTarget || el.querySelector('button, input, select, [tabindex]:not([tabindex="-1"])');
      if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
    }, 0);
  }

  function closeDialog(el, restoreFocus) {
    if (!el) return;
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
    if (restoreFocus === false) return;
    var target = el._returnFocus;
    if (target && document.contains(target) && typeof target.focus === 'function') {
      target.focus({ preventScroll: true });
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  function renderEmptyState(title, copy) {
    return '<div class="empty-state">' +
      '<div class="empty-title">' + escapeHtml(title) + '</div>' +
      '<div class="empty-copy">' + escapeHtml(copy) + '</div>' +
    '</div>';
  }

  function parsePlatform(folderName) {
    var idx = folderName.lastIndexOf(' - ');
    if (idx === -1) return { displayName: folderName, platform: null };
    return { displayName: folderName.slice(0, idx), platform: folderName.slice(idx + 3) };
  }

  function platformBrandKey(platform) {
    var value = String(platform || '').toLowerCase();
    if (value.includes('xbox')) return 'xbox';
    if (value.includes('playstation')) return 'playstation';
    if (value.includes('nintendo')) return 'nintendo';
    return '';
  }

  function renderPlatformPills() {
    var pillsEl = $('platformPills');
    if (!pillsEl) return;
    var platforms = [];
    Object.values(gameMeta).forEach(function (m) {
      if (m.platform && platforms.indexOf(m.platform) === -1) platforms.push(m.platform);
    });
    platforms.sort();
    if (platforms.length === 0) { pillsEl.hidden = true; return; }
    pillsEl.hidden = false;
    var tags = ['All'].concat(platforms);
    pillsEl.innerHTML = tags.map(function (p) {
      var brand = platformBrandKey(p);
      var brandClass = brand ? ' platform-pill-branded platform-pill-' + brand : '';
      return '<button class="platform-pill' + brandClass + (p === platformFilter ? ' active' : '') +
             '" type="button" aria-pressed="' + (p === platformFilter ? 'true' : 'false') +
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

  // ── Recent grid ───────────────────────────────────────────────────────
  function renderRecentGrid(opts) {
    opts = opts || {};
    if (recentItems.length === 0) {
      grid.innerHTML = renderEmptyState('NO CAPTURES DETECTED', 'Add screenshots or clips to your capture folder, then refresh the archive.');
      renderedRecentCount = 0;
      updateRecentMoreButton();
      return;
    }

    if (!opts.append || renderedRecentCount === 0) {
      var scrollTop = grid.scrollTop;
      grid.innerHTML = recentItems.map(function (item, i) {
        return renderTileHTML(item, i);
      }).join('');
      attachTileEvents(grid, recentItems);
      renderedRecentCount = recentItems.length;
      grid.scrollTop = scrollTop;
    } else {
      var startIdx = renderedRecentCount;
      var fresh = recentItems.slice(startIdx);
      if (fresh.length > 0) {
        var html = fresh.map(function (item, i) {
          return renderTileHTML(item, startIdx + i);
        }).join('');
        grid.insertAdjacentHTML('beforeend', html);
        // attachTileEvents is idempotent (marks bound tiles), so new tiles get handlers
        attachTileEvents(grid, recentItems);
        renderedRecentCount = recentItems.length;
      }
    }

    updateRecentMoreButton();
  }

  function updateRecentMoreButton() {
    if (recentShownCount) {
      if (recentItems.length === 0) {
        recentShownCount.textContent = '';
      } else {
        recentShownCount.textContent = recentItems.length + ' / ' + recentTotal + ' SHOWN';
      }
    }
    if (recentMoreBtn) {
      var moreLeft = recentItems.length < recentTotal;
      recentMoreBtn.style.display = moreLeft ? '' : 'none';
      recentMoreBtn.disabled = !moreLeft || recentLoading;
      recentMoreBtn.textContent = recentLoading ? 'LOADING...' : (moreLeft ? 'LOAD MORE' : 'ALL LOADED');
    }
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
      sg.innerHTML = renderEmptyState('NO STARRED CAPTURES', 'Star captures from the grid or viewer to build a quick highlight shelf.');
      return;
    }
    sg.innerHTML = items.map(function (item, i) { return renderTileHTML(item, i); }).join('');
    attachTileEvents(sg, items);
  }

  // ── Drilldown grid ────────────────────────────────────────────────────
  function renderDrilldownGrid(game, rawItems) {
    var items = rawItems.map(function (f) { return Object.assign({}, f, { game: game }); });
    if (items.length === 0) {
      drilldownGrid.innerHTML = renderEmptyState('NO CAPTURES', 'This game folder is present, but no supported capture files were found.');
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
    var gameLabel   = ((gameMeta[item.game] && gameMeta[item.game].displayName) || parsePlatform(item.game).displayName).toUpperCase();
    var safeName    = escapeHtml(item.name);
    var safePath    = escapeHtml(item.path);
    var tileLabel   = escapeHtml(gameLabel.slice(0, 24));
    var ariaLabel   = escapeHtml('Open ' + item.name + ' from ' + gameLabel);
    var media      = item.type === 'video'
      ? '<video poster="' + thumbUrl + '" muted loop preload="none" playsinline data-src="' + previewUrl + '" data-file="' + fileUrl + '"></video><div class="badge" data-dur-badge data-dur-path="' + safePath + '"><span class="badge-icon" aria-hidden="true">▶</span><span class="badge-text">CLIP</span></div>'
      : '<img src="' + thumbUrl + '" alt="' + safeName + '" loading="lazy" data-fallback="' + fileUrl + '">';
    return '<div class="tile" role="button" tabindex="0" data-index="' + i + '" aria-label="' + ariaLabel + '">' +
      '<button type="button" class="tile-star' + (starred ? ' starred' : '') +
        '" data-path="' + safePath + '" aria-label="' + (starred ? 'Unstar ' : 'Star ') + safeName +
        '" title="' + (starred ? 'Unstar capture' : 'Star capture') + '">' + (starred ? '★' : '☆') + '</button>' +
      media +
      '<div class="tile-label">' +
        '<span class="tile-title">' + tileLabel + '</span>' +
        '<span class="tile-date">' + date + '</span>' +
      '</div>' +
    '</div>';
  }

  function attachTileEvents(container, items) {
    container.querySelectorAll('.tile').forEach(function (tile) {
      if (tile.dataset.tileBound) return;
      tile.dataset.tileBound = '1';
      var idx  = parseInt(tile.dataset.index, 10);
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
          tile._hovered = true;
          if (video && !video.src) {
            video.src = video.dataset.src || '';
            video.load();
            video.addEventListener('canplay', function () {
              if (tile._hovered) video.play().catch(function () {});
            }, { once: true });
          } else if (video) {
            video.play().catch(function () {});
          }
        });
        tile.addEventListener('mouseleave', function () {
          tile._hovered = false;
          if (!video) return;
          video.pause();
          try { video.currentTime = 0; } catch (e) {}
        });
      }
      tile.addEventListener('click', function () { openLightbox(item, items, idx); });
      tile.addEventListener('keydown', function (e) {
        if (e.target !== tile) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        openLightbox(item, items, idx);
      });
    });
    if (durObserver) {
      container.querySelectorAll('[data-dur-badge]').forEach(function (b) {
        if (b.dataset.durObserved) return;
        b.dataset.durObserved = '1';
        durObserver.observe(b);
      });
    }
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
          btn.setAttribute('aria-label', data.starred ? 'Unstar capture' : 'Star capture');
          btn.title = data.starred ? 'Unstar capture' : 'Star capture';
        }
      });
      if (currentItem && currentItem.path === filePath) {
        var lbStar = $('lbStar');
        lbStar.textContent = data.starred ? '★ STARRED' : '☆ STAR';
        lbStar.classList.toggle('starred', data.starred);
        lbStar.setAttribute('aria-label', data.starred ? 'Unstar capture' : 'Star capture');
      }
      updateCounts();
      syncActivePanelsAfterReload();
    } catch {}
  }

  function formatDate(mtime) {
    var d = new Date(mtime);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function formatLightboxDate(mtime) {
    var d = new Date(mtime);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short' }) + ' ' + d.getDate() + ' ' + d.getFullYear();
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
    if (gamesCountEl) {
      var q = gamesSearchEl ? gamesSearchEl.value.trim() : '';
      gamesCountEl.textContent = q ? games.length + ' RESULTS' : games.length + (games.length === 1 ? ' GAME' : ' GAMES');
    }
    if (games.length === 0) {
      gamesGridEl.innerHTML = renderEmptyState('NO GAMES FOUND', 'Try a different search or platform filter.');
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
        artHtml = '<div class="game-card-art" data-bg="' + safeThumb + '">' +
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

      return '<div class="game-card" role="button" tabindex="0" data-game="' + escapeHtml(game) +
        '" aria-label="Open ' + escapeHtml(displayName) + ', ' + count + (count === 1 ? ' capture' : ' captures') + '">' +
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
      card.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        showDrilldown(card.dataset.game);
      });
    });
    if (artObserver) {
      gamesGridEl.querySelectorAll('[data-bg]').forEach(function (el) { artObserver.observe(el); });
    }
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
    // Snapshot the queue: Recent tiles pass the live `recentItems` array, which
    // the poll/settings reset mutates in place. Without the copy, pressing arrow
    // keys mid-refresh navigates an empty/reshuffled queue.
    lightboxQueue = queue ? queue.slice() : [];
    lightboxIndex = (idx !== undefined) ? idx : -1;

    var fileUrl = '/files/' + encodeURIComponent(item.path);
    lbContent.innerHTML = '';
    if (item.type === 'video') {
      lbContent.appendChild(buildVideoPlayer(fileUrl));
    } else {
      var img = document.createElement('img');
      img.src = fileUrl;
      img.alt = item.name;
      lbContent.appendChild(img);
    }

    var parsedGame = gameMeta[item.game] || parsePlatform(item.game);
    var displayGame = parsedGame.displayName || item.game;
    var platform = parsedGame.platform || '';
    $('lbGame').textContent = displayGame.toUpperCase();
    $('lbPlatform').textContent = platform.toUpperCase();
    $('lbPlatform').hidden = !platform;
    $('lbPlatformSep').hidden = !platform;
    $('lbName').textContent = item.name;
    $('lbDate').textContent = formatLightboxDate(item.mtime);

    var starred = favorites.has(item.path);
    $('lbStar').textContent = starred ? '★ STARRED' : '☆ STAR';
    $('lbStar').classList.toggle('starred', starred);
    $('lbStar').setAttribute('aria-label', starred ? 'Unstar capture' : 'Star capture');

    $('lbDetail').hidden = true;
    $('lbMetaSep2').hidden = true;
    fetchFileMeta(item.path);

    updateNavArrows();
    lbMeta.hidden = false;
    openDialog(lightbox, $('lbClose'));
  }

  function closeLightbox() {
    var vid = lbContent.querySelector('.vplayer-video');
    if (vid) {
      vid.pause();
      vid.removeAttribute('src');
      try { vid.load(); } catch (e) {}
    }
    if (document.fullscreenElement) document.exitFullscreen();
    closeDialog(lightbox);
    lbContent.innerHTML = '';
    lbMeta.hidden = true;
    $('lbPlatform').hidden = true;
    $('lbPlatformSep').hidden = true;
    $('lbDetail').hidden = true;
    $('lbMetaSep2').hidden = true;
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
    $('lbDetail').hidden = false;
    $('lbMetaSep2').hidden = false;
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
      if (shareModal.classList.contains('open'))         closeDialog(shareModal);
      else if (settingsModal.classList.contains('open')) closeDialog(settingsModal);
      else if (lightbox.classList.contains('open'))      closeLightbox();
      else if (currentDrillGame)                         showLibrary();
      return;
    }
    // ←/→ always navigate items; j/l seek video ±5s; space/k play-pause; m mute; f fullscreen
    if (!lightbox.classList.contains('open') || shareModal.classList.contains('open')) return;
    var activeTag = document.activeElement && document.activeElement.tagName;
    if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;
    var vid = lbContent.querySelector('.vplayer-video');
    if (e.key === 'ArrowLeft')  { e.preventDefault(); navigateLightbox(-1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); navigateLightbox(+1); return; }
    if (!vid) return;
    if (e.key === ' ' || e.key === 'k') {
      e.preventDefault();
      if (vid.paused || vid.ended) vid.play().catch(function () {}); else vid.pause();
    } else if (e.key === 'j' || e.key === 'J') {
      e.preventDefault();
      vid.currentTime = Math.max(0, vid.currentTime - 5);
    } else if (e.key === 'l' || e.key === 'L') {
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
      shareUrlEl.value = data.url.startsWith('http') ? data.url : window.location.origin + data.url;
      openDialog(shareModal, shareUrlEl);
    } catch { alert('share failed'); }
  });

  $('copyBtn').addEventListener('click', function () {
    shareUrlEl.select();
    navigator.clipboard.writeText(shareUrlEl.value).then(function () {
      $('copyBtn').textContent = '✓ COPIED';
      setTimeout(function () { $('copyBtn').textContent = '⊕ COPY'; }, 1500);
    });
  });

  $('shareClose').addEventListener('click', function () { closeDialog(shareModal); });
  shareModal.addEventListener('click', function (e) { if (e.target === shareModal) closeDialog(shareModal); });

  // ── Settings ───────────────────────────────────────────────────────────
  async function loadRenderCapabilities() {
    var hardwareLabel = $('hardwareLabel');
    var hardwareDesc  = $('hardwareDesc');
    var hardwareSelect = $('hardwareDeviceSelect');
    try {
      var res = await fetch('/api/render-capabilities');
      if (!res.ok) throw new Error('bad response');
      var data = await res.json();
      var hardwareRadio = document.querySelector('input[name="settingsRenderMode"][value="hardware"]');
      var softwareRadio = document.querySelector('input[name="settingsRenderMode"][value="software"]');
      hardwareSelect.innerHTML = '';
      var autoOption = document.createElement('option');
      autoOption.value = 'auto';
      autoOption.textContent = data.best ? 'Auto (' + data.best.label + ')' : 'Auto';
      hardwareSelect.appendChild(autoOption);
      (data.available || []).forEach(function (target) {
        var option = document.createElement('option');
        option.value = target.id;
        option.textContent = target.label;
        hardwareSelect.appendChild(option);
      });
      if (data.best) {
        hardwareLabel.textContent = '(' + data.best.label + ')';
        hardwareDesc.textContent  = 'detected: ' + data.best.name;
        hardwareRadio.disabled = false;
        hardwareSelect.disabled = false;
      } else {
        hardwareLabel.textContent = '(unavailable)';
        hardwareDesc.textContent  = 'no hardware encoder detected';
        hardwareRadio.disabled = true;
        hardwareSelect.disabled = true;
      }
      hardwareSelect.value = data.hardwareDevice || 'auto';
      if (hardwareSelect.value !== (data.hardwareDevice || 'auto')) hardwareSelect.value = 'auto';
      var current = data.current === 'hardware' && !hardwareRadio.disabled ? 'hardware' : 'software';
      (current === 'hardware' ? hardwareRadio : softwareRadio).checked = true;
    } catch {
      $('renderMsg').textContent = '✗ could not load render capabilities';
      $('renderMsg').className = 'settings-msg bad';
    }
  }

  $('settingsBtn').addEventListener('click', function () {
    $('folderMsg').textContent = '';
    $('passMsg').textContent = '';
    $('renderMsg').textContent = '';
    $('currentPass').value = '';
    $('newPass').value = '';
    openDialog(settingsModal, $('folderInput'));
    loadRenderCapabilities();
  });
  $('settingsClose').addEventListener('click', function () { closeDialog(settingsModal); });
  settingsModal.addEventListener('click', function (e) { if (e.target === settingsModal) closeDialog(settingsModal); });

  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      refreshLibrary(true);
    });
  }

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
        await Promise.all([loadConfig(), loadFavorites()]);
        await refreshLibrary(true);
      } else {
        msg.textContent = '✗ ' + (data.error || 'failed');
        msg.className = 'settings-msg bad';
      }
    } catch {
      msg.textContent = '✗ NETWORK ERROR';
      msg.className = 'settings-msg bad';
    }
  });

  $('saveSiteUrlBtn').addEventListener('click', async function () {
    var newUrl = $('siteUrlInput').value.trim();
    var msg = $('siteUrlMsg');
    msg.textContent = '';
    try {
      var res = await fetch('/api/config/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteUrl: newUrl }),
      });
      var data = await res.json();
      if (res.ok) {
        siteUrl = data.siteUrl || '';
        $('siteUrlInput').value = siteUrl;
        msg.textContent = siteUrl ? '✓ SITE URL UPDATED' : '✓ SITE URL CLEARED';
        msg.className = 'settings-msg ok';
      } else {
        msg.textContent = '✗ ' + (data.error || 'failed');
        msg.className = 'settings-msg bad';
      }
    } catch {
      msg.textContent = '✗ NETWORK ERROR';
      msg.className = 'settings-msg bad';
    }
  });

  $('saveRenderBtn').addEventListener('click', async function () {
    var picked = document.querySelector('input[name="settingsRenderMode"]:checked');
    var mode = picked ? picked.value : 'software';
    var hardwareDevice = $('hardwareDeviceSelect').value || 'auto';
    var msg = $('renderMsg');
    msg.textContent = '';
    try {
      var res = await fetch('/api/config/render-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: mode, hardwareDevice: hardwareDevice }),
      });
      var data = await res.json();
      if (res.ok) {
        msg.textContent = '✓ RENDER MODE: ' + data.mode.toUpperCase();
        msg.className = 'settings-msg ok';
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

  $('trustProxySelect').addEventListener('change', function () {
    $('trustProxyHops').style.display = this.value === 'hops' ? '' : 'none';
  });

  $('saveSecurityBtn').addEventListener('click', async function () {
    var msg = $('securityMsg');
    msg.textContent = '';
    var tpSel = $('trustProxySelect').value;
    var tpHops = parseInt($('trustProxyHops').value, 10);
    var csSel = $('cookieSecureSelect').value;

    var trustProxy;
    if (tpSel === 'on') trustProxy = true;
    else if (tpSel === 'hops') {
      if (!Number.isInteger(tpHops) || tpHops < 1 || tpHops > 9) {
        msg.textContent = '✗ hops must be 1–9';
        msg.className = 'settings-msg bad';
        return;
      }
      trustProxy = tpHops;
    } else trustProxy = false;

    var cookieSecure;
    if (csSel === 'true') cookieSecure = true;
    else if (csSel === 'false') cookieSecure = false;
    else cookieSecure = 'auto';

    try {
      var res = await fetch('/api/config/security', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trustProxy: trustProxy, cookieSecure: cookieSecure }),
      });
      var data = await res.json();
      if (res.ok) {
        msg.textContent = '✓ SAVED — RESTART SERVER TO APPLY';
        msg.className = 'settings-msg ok';
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
    await refreshLibrary(false);

    setInterval(async function () {
      try {
        var res = await fetch('/api/captures/version');
        if (!res.ok) return;
        var newVersion = versionKey(await res.json());
        if (newVersion === capturesVersion) return;
        await refreshLibrary(false);
      } catch {}
    }, 30000);
  })();
})();

(function () {
  let allCaptures = {};
  let currentFilter = 'All';
  let currentItem = null;
  let currentDrillGame = null;

  function $(id) { return document.getElementById(id); }

  const grid          = $('grid');
  const filtersEl     = $('filters');
  const lightbox      = $('lightbox');
  const lbContent     = $('lbContent');
  const lbMeta        = $('lbMeta');
  const shareModal    = $('shareModal');
  const settingsModal = $('settingsModal');
  const shareUrlEl    = $('shareUrl');

  // ── Tab switching ──────────────────────────────────────────────────────
  var tabRecent  = $('tabRecent');
  var tabGames   = $('tabGames');
  var panelRecent = $('panelRecent');
  var panelGames  = $('panelGames');

  function setTab(name) {
    if (name === 'recent') {
      tabRecent.classList.add('active');
      tabGames.classList.remove('active');
      panelRecent.classList.add('active');
      panelGames.classList.remove('active');
    } else {
      tabGames.classList.add('active');
      tabRecent.classList.remove('active');
      panelGames.classList.add('active');
      panelRecent.classList.remove('active');
      // Reset drilldown
      showLibrary();
    }
  }

  tabRecent.addEventListener('click', function () { setTab('recent'); });
  tabGames.addEventListener('click', function () { setTab('games'); });

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
    $('drilldownTitle').textContent = game.toUpperCase();
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
    $('hello').textContent = cfg.username + "'s archive";
    $('folderLabel').textContent = cfg.capturesPath;
    $('folderInput').value = cfg.capturesPath;
  }

  async function loadCaptures() {
    const res = await fetch('/api/captures');
    if (res.status === 401) { window.location.href = '/login'; return; }
    allCaptures = await res.json();
    renderFilters();   // keeps JS compat, hidden in CSS
    renderGrid();      // recent grid
    updateCounts();
    renderGamesGrid(Object.keys(allCaptures).sort());
  }

  function updateCounts() {
    var games = Object.keys(allCaptures);
    var total = 0;
    games.forEach(function (g) { total += allCaptures[g].length; });
    $('recentCount').textContent = total;
    $('gamesCount').textContent  = games.length;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
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
  function renderGrid() {
    var items = [];
    var games = Object.keys(allCaptures).sort();
    games.forEach(function (g) {
      allCaptures[g].forEach(function (f) { items.push(Object.assign({}, f, { game: g })); });
    });
    items.sort(function (a, b) { return b.mtime - a.mtime; });

    if (items.length === 0) {
      grid.innerHTML = '<div class="empty">// NO CAPTURES DETECTED</div>';
      return;
    }

    grid.innerHTML = items.map(function (item, i) {
      return renderTileHTML(item, i);
    }).join('');

    attachTileEvents(grid, items);
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
    var fileUrl = '/files/' + encodeURIComponent(item.path);
    var date    = formatDate(item.mtime);
    var media   = item.type === 'video'
      ? '<video src="' + fileUrl + '" muted loop preload="metadata" playsinline></video><div class="badge">▶ CLIP</div>'
      : '<img src="' + fileUrl + '" alt="' + escapeHtml(item.name) + '" loading="lazy">';
    return '<div class="tile" data-index="' + i + '">' +
      media +
      '<div class="tile-label">' +
        '<span>' + escapeHtml(item.game.toUpperCase().slice(0, 18)) + '</span>' +
        '<span class="tile-date">' + date + '</span>' +
      '</div>' +
    '</div>';
  }

  function attachTileEvents(container, items) {
    container.querySelectorAll('.tile').forEach(function (tile) {
      var idx  = parseInt(tile.dataset.index);
      var item = items[idx];
      if (item.type === 'video') {
        var video = tile.querySelector('video');
        tile.addEventListener('mouseenter', function () { video.play().catch(function () {}); });
        tile.addEventListener('mouseleave', function () { video.pause(); video.currentTime = 0; });
      }
      tile.addEventListener('click', function () { openLightbox(item); });
    });
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
      return g.toLowerCase().includes(q);
    });
    gamesCountEl.textContent = q ? games.length + ' RESULTS' : '';
    renderGamesGrid(games);
  });

  function renderGamesGrid(games) {
    if (games.length === 0) {
      gamesGridEl.innerHTML = '<div class="empty" style="grid-column:1/-1">// NO GAMES FOUND</div>';
      return;
    }
    gamesGridEl.innerHTML = games.map(function (game) {
      var items   = allCaptures[game] || [];
      var count   = items.length;
      var hasClip = items.some(function (i) { return i.type === 'video'; });
      var latest  = items.reduce(function (a, b) { return b.mtime > a.mtime ? b : a; }, items[0] || { mtime: 0 });
      var date    = latest.mtime ? formatDate(latest.mtime) : '';

      // Deterministic art params from game name length
      var n   = game.length;
      var ang = (n * 17) % 180;
      var sl  = (n * 13) % 90 + 20;
      var a1  = n * 7 % 8;      var b1 = n * 11 % 60 + 20;
      var a2  = n * 3 % 15 + 10; var b2 = n * 7 % 40 + 40;
      var a3  = n * 9 % 20 + 20; var b3 = n * 5 % 30 + 10;
      var a4  = n * 11 % 20 + 35;var b4 = n * 13 % 50 + 30;
      var a5  = n * 7 % 15 + 50; var b5 = n * 11 % 25 + 5;
      var a6  = n * 13 % 15 + 65;var b6 = n * 7 % 40 + 30;
      var a7  = n * 5 % 15 + 78; var b7 = n * 9 % 35 + 20;
      var a8  = 95;               var b8 = n * 11 % 40 + 35;

      // Hue from name
      var hue   = (n * 47 + game.charCodeAt(0) * 3) % 360;
      var color = 'hsl(' + hue + ',60%,50%)';
      var dark  = 'hsl(' + hue + ',40%,12%)';

      var sil = 'polygon(0 100%,' + a1 + '% ' + b1 + '%,' + a2 + '% ' + b2 + '%,' +
                a3 + '% ' + b3 + '%,' + a4 + '% ' + b4 + '%,' + a5 + '% ' + b5 + '%,' +
                a6 + '% ' + b6 + '%,' + a7 + '% ' + b7 + '%,' + a8 + '% ' + b8 + '%,100% 100%)';

      return '<div class="game-card" data-game="' + escapeHtml(game) + '">' +
        '<div class="game-card-art" style="background:linear-gradient(' + ang + 'deg,hsl(' + hue + ',45%,18%),hsl(' + hue + ',30%,8%))">' +
          '<div style="position:absolute;inset:0;background:repeating-linear-gradient(' + sl + 'deg,hsla(' + hue + ',60%,50%,0.06) 0px,hsla(' + hue + ',60%,50%,0.06) 1px,transparent 1px,transparent ' + (6 + n % 6) + 'px)"></div>' +
          '<div style="position:absolute;bottom:0;left:0;right:0;height:55%;background:linear-gradient(transparent,hsl(' + hue + ',40%,6%))"></div>' +
          '<div style="position:absolute;bottom:0;left:5%;right:5%;height:40%;background:hsl(' + hue + ',30%,10%);clip-path:' + sil + '"></div>' +
        '</div>' +
        '<div class="game-card-info">' +
          '<div class="game-card-name">' + escapeHtml(game) + '</div>' +
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

  // ── Lightbox ──────────────────────────────────────────────────────────
  function openLightbox(item) {
    currentItem = item;
    var fileUrl = '/files/' + encodeURIComponent(item.path);
    lbContent.innerHTML = item.type === 'video'
      ? '<video src="' + fileUrl + '" controls autoplay></video>'
      : '<img src="' + fileUrl + '" alt="' + escapeHtml(item.name) + '">';

    // Populate meta bar
    $('lbGame').textContent = item.game.toUpperCase();
    $('lbName').textContent = item.name;
    $('lbDate').textContent = formatDate(item.mtime);
    lbMeta.style.display = 'flex';

    lightbox.classList.add('open');
  }

  function closeLightbox() {
    lightbox.classList.remove('open');
    lbContent.innerHTML = '';
    lbMeta.style.display = 'none';
    currentItem = null;
  }

  $('lbClose').addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', function (e) {
    if (e.target === lightbox) closeLightbox();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (shareModal.classList.contains('open'))    shareModal.classList.remove('open');
      else if (settingsModal.classList.contains('open')) settingsModal.classList.remove('open');
      else if (lightbox.classList.contains('open')) closeLightbox();
      else if (currentDrillGame) showLibrary();
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
      shareUrlEl.value = window.location.origin + data.url;
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

  // ── Init ───────────────────────────────────────────────────────────────
  (async function () {
    await loadConfig();
    await loadCaptures();
  })();
})();

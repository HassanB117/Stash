(function () {
  let allCaptures = {};
  let currentFilter = 'All';
  let currentItem = null;

  function $(id) { return document.getElementById(id); }

  const grid = $('grid');
  const filtersEl = $('filters');
  const lightbox = $('lightbox');
  const lbContent = $('lbContent');
  const shareModal = $('shareModal');
  const settingsModal = $('settingsModal');
  const shareUrlEl = $('shareUrl');

  async function loadConfig() {
    const res = await fetch('/api/config');
    if (res.status === 401) { window.location.href = '/login'; return; }
    const cfg = await res.json();
    $('hello').textContent = cfg.username + "'s captures";
    $('folderLabel').textContent = cfg.capturesPath;
    $('folderInput').value = cfg.capturesPath;
  }

  async function loadCaptures() {
    const res = await fetch('/api/captures');
    if (res.status === 401) { window.location.href = '/login'; return; }
    allCaptures = await res.json();
    renderFilters();
    renderGrid();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  function renderFilters() {
    const games = Object.keys(allCaptures).sort();
    const tags = ['All'].concat(games);
    filtersEl.innerHTML = tags.map(function (t) {
      return '<span class="filter ' + (t === currentFilter ? 'active' : '') + '" data-game="' + escapeHtml(t) + '">' + escapeHtml(t) + '</span>';
    }).join('');
    filtersEl.querySelectorAll('.filter').forEach(function (el) {
      el.addEventListener('click', function () {
        currentFilter = el.dataset.game;
        renderFilters();
        renderGrid();
      });
    });
  }

  function renderGrid() {
    let items = [];
    if (currentFilter === 'All') {
      for (const game of Object.keys(allCaptures)) {
        allCaptures[game].forEach(function (f) { items.push(Object.assign({}, f, { game: game })); });
      }
      items.sort(function (a, b) { return b.mtime - a.mtime; });
    } else {
      items = (allCaptures[currentFilter] || []).map(function (f) {
        return Object.assign({}, f, { game: currentFilter });
      });
    }

    if (items.length === 0) {
      grid.innerHTML = '<div class="empty">no captures yet — drop game folders into your captures folder, then refresh</div>';
      return;
    }

    grid.innerHTML = items.map(function (item, i) {
      const fileUrl = '/files/' + encodeURIComponent(item.path);
      const media = item.type === 'video'
        ? '<video src="' + fileUrl + '" muted loop preload="metadata" playsinline></video><div class="badge">▶</div>'
        : '<img src="' + fileUrl + '" alt="' + escapeHtml(item.name) + '" loading="lazy">';
      return '<div class="tile" data-index="' + i + '">' + media + '<div class="tile-label">' + escapeHtml(item.game) + '</div></div>';
    }).join('');

    grid.querySelectorAll('.tile').forEach(function (tile) {
      const idx = parseInt(tile.dataset.index);
      const item = items[idx];
      if (item.type === 'video') {
        const video = tile.querySelector('video');
        tile.addEventListener('mouseenter', function () { video.play().catch(function () {}); });
        tile.addEventListener('mouseleave', function () { video.pause(); video.currentTime = 0; });
      }
      tile.addEventListener('click', function () { openLightbox(item); });
    });
  }

  function openLightbox(item) {
    currentItem = item;
    const fileUrl = '/files/' + encodeURIComponent(item.path);
    lbContent.innerHTML = item.type === 'video'
      ? '<video src="' + fileUrl + '" controls autoplay></video>'
      : '<img src="' + fileUrl + '" alt="' + escapeHtml(item.name) + '">';
    lightbox.classList.add('open');
  }

  function closeLightbox() {
    lightbox.classList.remove('open');
    lbContent.innerHTML = '';
    currentItem = null;
  }

  $('lbClose').addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', function (e) { if (e.target === lightbox) closeLightbox(); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (shareModal.classList.contains('open')) shareModal.classList.remove('open');
      else if (settingsModal.classList.contains('open')) settingsModal.classList.remove('open');
      else if (lightbox.classList.contains('open')) closeLightbox();
    }
  });

  $('lbShare').addEventListener('click', async function () {
    if (!currentItem) return;
    try {
      const res = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: currentItem.path }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || 'failed'); return; }
      shareUrlEl.value = window.location.origin + data.url;
      shareModal.classList.add('open');
    } catch {
      alert('share failed');
    }
  });

  $('copyBtn').addEventListener('click', function () {
    shareUrlEl.select();
    navigator.clipboard.writeText(shareUrlEl.value).then(function () {
      $('copyBtn').textContent = 'copied';
      setTimeout(function () { $('copyBtn').textContent = 'copy'; }, 1500);
    });
  });

  $('shareClose').addEventListener('click', function () { shareModal.classList.remove('open'); });
  shareModal.addEventListener('click', function (e) { if (e.target === shareModal) shareModal.classList.remove('open'); });

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
    const newPath = $('folderInput').value.trim();
    const msg = $('folderMsg');
    msg.textContent = '';
    try {
      const res = await fetch('/api/config/path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capturesPath: newPath }),
      });
      const data = await res.json();
      if (res.ok) {
        msg.textContent = '✓ folder updated';
        msg.className = 'settings-msg ok';
        await loadConfig();
        await loadCaptures();
      } else {
        msg.textContent = '✗ ' + (data.error || 'failed');
        msg.className = 'settings-msg bad';
      }
    } catch {
      msg.textContent = '✗ network error';
      msg.className = 'settings-msg bad';
    }
  });

  $('savePassBtn').addEventListener('click', async function () {
    const cur = $('currentPass').value;
    const nw = $('newPass').value;
    const msg = $('passMsg');
    msg.textContent = '';
    try {
      const res = await fetch('/api/config/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: cur, newPassword: nw }),
      });
      const data = await res.json();
      if (res.ok) {
        msg.textContent = '✓ password changed';
        msg.className = 'settings-msg ok';
        $('currentPass').value = '';
        $('newPass').value = '';
      } else {
        msg.textContent = '✗ ' + (data.error || 'failed');
        msg.className = 'settings-msg bad';
      }
    } catch {
      msg.textContent = '✗ network error';
      msg.className = 'settings-msg bad';
    }
  });

  $('logoutBtn').addEventListener('click', async function () {
    await fetch('/logout', { method: 'POST' });
    window.location.href = '/login';
  });

  (async function () {
    await loadConfig();
    await loadCaptures();
  })();
})();

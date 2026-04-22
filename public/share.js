(async function () {
  const token = location.pathname.split('/')[2];
  const $ = id => document.getElementById(id);

  const card = $('shareCard');
  const mediaWrap = $('mediaWrap');
  const loading = $('loading');
  const statusLabel = $('statusLabel');

  function showMessage(text) {
    loading.textContent = '// ' + text;
    loading.style.display = 'block';
    card.style.display = 'none';
    statusLabel.textContent = 'ERROR';
  }

  try {
    const res = await fetch('/s/' + token + '/meta');
    if (!res.ok) {
      showMessage('LINK EXPIRED OR NOT FOUND');
      return;
    }

    const meta = await res.json();
    const src = '/s/' + token + '/file';
    const expires = new Date(meta.expiresAt);
    const now = new Date();
    const diffHours = Math.round((expires - now) / (1000 * 60 * 60));

    // Update Meta
    $('filename').textContent = meta.name;
    $('fileType').textContent = (meta.type === 'video' ? 'VIDEO CLIP' : 'IMAGE CAPTURE') + ' · ' + meta.name.split('.').pop().toUpperCase();
    $('expiry').textContent = '// EXPIRES IN ' + diffHours + ' HOURS (' + expires.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ')';
    statusLabel.textContent = 'READY TO VIEW';

    // Insert Media
    mediaWrap.innerHTML = '';
    if (meta.type === 'video') {
      const player = window.buildVideoPlayer(src);
      mediaWrap.appendChild(player);
    } else {
      const img = document.createElement('img');
      img.src = src;
      img.alt = meta.name;
      mediaWrap.appendChild(img);
    }

    loading.style.display = 'none';
    card.style.display = 'block';
    document.title = 'stash · ' + meta.name;

  } catch (err) {
    console.error(err);
    showMessage('FAILED TO LOAD DATA');
  }
})();

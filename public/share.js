(async function () {
  const token = window.location.pathname.split('/').pop();
  const wrap = document.getElementById('shareWrap');
  try {
    const res = await fetch('/s/' + token + '/meta');
    if (!res.ok) {
      wrap.innerHTML = '<div class="loading">link expired or invalid</div>';
      return;
    }
    const meta = await res.json();
    const fileUrl = '/s/' + token + '/file';
    if (meta.type === 'video') {
      const v = document.createElement('video');
      v.src = fileUrl;
      v.controls = true;
      v.autoplay = true;
      wrap.innerHTML = '';
      wrap.appendChild(v);
    } else {
      const img = document.createElement('img');
      img.src = fileUrl;
      img.alt = meta.name;
      wrap.innerHTML = '';
      wrap.appendChild(img);
    }
  } catch {
    wrap.innerHTML = '<div class="loading">something went wrong</div>';
  }
})();

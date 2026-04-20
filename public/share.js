(async function () {
  var token = location.pathname.split('/')[2];
  var el    = document.getElementById('content');
  try {
    var res  = await fetch('/s/' + token + '/meta');
    if (!res.ok) {
      el.innerHTML = '<div style="font-size:10px;letter-spacing:3px;color:var(--text-dim);">// LINK EXPIRED OR NOT FOUND</div>';
      return;
    }
    var meta = await res.json();
    var src  = '/s/' + token + '/file';
    var expires = new Date(meta.expiresAt).toLocaleString();
    var media = meta.type === 'video'
      ? '<video src="' + src + '" controls autoplay></video>'
      : '<img src="' + src + '" alt="' + meta.name + '">';
    el.innerHTML = media +
      '<div class="share-meta"><span>' + meta.name + '</span></div>' +
      '<div class="share-expiry">// LINK EXPIRES ' + expires.toUpperCase() + '</div>';
    document.title = 'stash \xb7 ' + meta.name;
  } catch {
    el.innerHTML = '<div style="font-size:10px;letter-spacing:3px;color:var(--text-dim);">// FAILED TO LOAD</div>';
  }
})();

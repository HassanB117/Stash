document.getElementById('loginForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  var err = document.getElementById('error');
  err.textContent = '';
  try {
    var res = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
      }),
    });
    var data = await res.json();
    if (res.ok) { window.location.href = '/'; }
    else { err.textContent = data.error || 'login failed'; }
  } catch {
    err.textContent = 'network error';
  }
});

var setupLink = document.getElementById('setupLink');
if (setupLink) {
  setupLink.addEventListener('mouseenter', function () {
    setupLink.style.color = 'var(--accent)';
  });
  setupLink.addEventListener('mouseleave', function () {
    setupLink.style.color = 'var(--text-dim)';
  });
}

function updateTime() {
  var el = document.getElementById('sysTime');
  if (el) el.textContent = 'SYSTEM ONLINE · ' + new Date().toUTCString().slice(0, 16).toUpperCase();
}

updateTime();
setInterval(updateTime, 1000);

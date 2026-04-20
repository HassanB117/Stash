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

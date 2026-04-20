(function () {
  var account = {};

  function goTo(n) {
    document.querySelectorAll('.step-panel').forEach(function (p) { p.classList.remove('active'); });
    document.querySelectorAll('.step').forEach(function (s) {
      s.classList.toggle('active', +s.dataset.step <= n);
      s.classList.toggle('current', +s.dataset.step === n);
    });
    document.getElementById('panel-' + n).classList.add('active');
  }

  document.getElementById('next-1').addEventListener('click', function () {
    var u   = document.getElementById('username').value.trim();
    var p   = document.getElementById('password').value;
    var c   = document.getElementById('passwordConfirm').value;
    var err = document.getElementById('error-1');
    err.textContent = '';
    if (u.length < 2)  { err.textContent = 'username must be at least 2 characters'; return; }
    if (u.length > 32) { err.textContent = 'username must be at most 32 characters'; return; }
    if (p.length < 8)  { err.textContent = 'password must be at least 8 characters'; return; }
    if (p !== c)       { err.textContent = 'passwords do not match'; return; }
    account = { username: u, password: p };
    goTo(2);
  });

  document.getElementById('back-2').addEventListener('click', function () { goTo(1); });

  document.getElementById('next-2').addEventListener('click', async function () {
    var fp     = document.getElementById('folderPath').value.trim();
    var err    = document.getElementById('error-2');
    var status = document.getElementById('folderStatus');
    err.textContent    = '';
    status.textContent = 'CHECKING PATH...';
    try {
      var check = await fetch('/api/setup/check-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: fp }),
      });
      var cd = await check.json();
      if (!cd.ok) { status.textContent = ''; err.textContent = cd.error || 'invalid path'; return; }
      status.textContent = '✓ ' + cd.resolved;
      var res  = await fetch('/api/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: account.username, password: account.password, capturesPath: fp }),
      });
      var data = await res.json();
      if (res.ok) { goTo(3); }
      else { status.textContent = ''; err.textContent = data.error || 'setup failed'; }
    } catch {
      status.textContent = '';
      err.textContent = 'network error';
    }
  });

  document.getElementById('goLogin').addEventListener('click', function () {
    window.location.href = '/login';
  });
})();

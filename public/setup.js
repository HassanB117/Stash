(function () {
  var account = {};
  var folder = '';

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
      folder = fp;
      goTo(3);
    } catch {
      status.textContent = '';
      err.textContent = 'network error';
    }
  });

  document.getElementById('back-3').addEventListener('click', function () { goTo(2); });

  document.getElementById('next-3').addEventListener('click', async function () {
    var err = document.getElementById('error-3');
    err.textContent = '';
    var picked = document.querySelector('input[name="renderMode"]:checked');
    var mode = picked ? picked.value : 'software';
    try {
      var res = await fetch('/api/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: account.username,
          password: account.password,
          capturesPath: folder,
          renderMode: mode,
          hardwareDevice: 'auto',
        }),
      });
      var data = await res.json();
      if (res.ok) { goTo(4); }
      else { err.textContent = data.error || 'setup failed'; }
    } catch {
      err.textContent = 'network error';
    }
  });

  document.getElementById('goLogin').addEventListener('click', function () {
    window.location.href = '/login';
  });
})();

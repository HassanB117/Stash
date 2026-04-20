(function () {
  const account = { username: '', password: '' };
  let folderPath = '';

  function $(id) { return document.getElementById(id); }

  function showStep(n) {
    document.querySelectorAll('.step').forEach(s => {
      const sn = parseInt(s.dataset.step);
      s.classList.toggle('active', sn <= n);
      s.classList.toggle('current', sn === n);
    });
    document.querySelectorAll('.step-panel').forEach(p => p.classList.remove('active'));
    $('panel-' + n).classList.add('active');
  }

  // Step 1 → 2
  $('next-1').addEventListener('click', function () {
    const u = $('username').value.trim();
    const p = $('password').value;
    const pc = $('passwordConfirm').value;
    const err = $('error-1');
    err.textContent = '';
    if (u.length < 2) { err.textContent = 'username too short'; return; }
    if (u.length > 32) { err.textContent = 'username too long (max 32)'; return; }
    if (p.length < 8) { err.textContent = 'password must be at least 8 characters'; return; }
    if (p !== pc) { err.textContent = 'passwords do not match'; return; }
    account.username = u;
    account.password = p;
    showStep(2);
  });

  // Live folder check
  let checkTimer;
  const folderInput = $('folderPath');
  const folderStatus = $('folderStatus');

  folderInput.addEventListener('input', function () {
    const val = folderInput.value.trim();
    folderStatus.textContent = '';
    folderStatus.className = 'folder-status';
    folderPath = '';
    clearTimeout(checkTimer);
    if (!val) return;
    checkTimer = setTimeout(async function () {
      try {
        const res = await fetch('/api/setup/check-path', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: val }),
        });
        const data = await res.json();
        if (data.ok) {
          folderStatus.textContent = '✓ folder found';
          folderStatus.className = 'folder-status ok';
          folderPath = val;
        } else {
          folderStatus.textContent = '✗ ' + data.error;
          folderStatus.className = 'folder-status bad';
        }
      } catch {
        folderStatus.textContent = '✗ check failed';
        folderStatus.className = 'folder-status bad';
      }
    }, 400);
  });

  $('back-2').addEventListener('click', function () { showStep(1); });

  $('next-2').addEventListener('click', async function () {
    const err = $('error-2');
    err.textContent = '';
    const val = folderInput.value.trim();
    if (!val) { err.textContent = 'enter a folder path'; return; }
    if (!folderPath) { err.textContent = 'wait for the folder check, or fix the path'; return; }
    try {
      const res = await fetch('/api/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: account.username,
          password: account.password,
          capturesPath: folderPath,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        showStep(3);
      } else {
        err.textContent = data.error || 'setup failed';
      }
    } catch {
      err.textContent = 'network error';
    }
  });

  $('goLogin').addEventListener('click', function () {
    window.location.href = '/login';
  });

  // Press Enter on step 1 to advance
  ['username', 'password', 'passwordConfirm'].forEach(function (id) {
    $(id).addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('next-1').click(); }
    });
  });
  $('folderPath').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); $('next-2').click(); }
  });
})();

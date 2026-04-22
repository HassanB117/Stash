(function () {
  const nativeFetch = window.fetch.bind(window);
  let csrfToken = null;
  let csrfPromise = null;

  async function initCsrf() {
    if (csrfToken) return csrfToken;
    if (!csrfPromise) {
      csrfPromise = nativeFetch('/api/csrf', { credentials: 'same-origin' })
        .then(async (res) => {
          if (!res.ok) throw new Error('csrf unavailable');
          const data = await res.json();
          csrfToken = data.csrfToken || null;
          return csrfToken;
        })
        .catch(() => null)
        .finally(() => {
          csrfPromise = null;
        });
    }
    return csrfPromise;
  }

  async function csrfFetch(input, init) {
    const options = init ? { ...init } : {};
    const method = String(options.method || (input && input.method) || 'GET').toUpperCase();
    if (method !== 'GET') {
      const token = await initCsrf();
      const headers = new Headers(options.headers || (input instanceof Request ? input.headers : undefined));
      if (token) headers.set('X-CSRF-Token', token);
      options.headers = headers;
      options.credentials = options.credentials || 'same-origin';
    }
    return nativeFetch(input, options);
  }

  window.initCsrf = initCsrf;
  window.csrfFetch = csrfFetch;
  window.fetch = csrfFetch;
})();

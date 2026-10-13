(function () {
  // The ThingsBoard Angular UI embedded in the dashboard iframe resolves its
  // display language from, in order: the signed-in user's saved language
  // (`additionalInfo.lang`), then `navigator.language`. The demo tenant user
  // has no saved language, so the whole Angular app fell back to the browser
  // locale (English) even though a Persian bundle exists on the backend.
  //
  // The Vue shell stores the chosen locale under a versioned key
  // ("<app-id>-preferences-locale"), and the iframe shares its origin. Mirror
  // that locale onto `navigator` here, before the Angular bundles bootstrap, so
  // the embedded UI renders in Persian too. Non-Persian locales are left
  // untouched, so this is a no-op for every other language.
  let lang = null;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.includes('-preferences-locale')) {
        const raw = localStorage.getItem(key);
        if (raw) {
          try {
            lang = JSON.parse(raw).value;
          } catch {
            lang = raw;
          }
        }
      }
    }
  } catch {}
  if (!lang || !String(lang).startsWith('fa')) return;

  const culture = String(lang).replace('_', '-');
  try {
    Object.defineProperty(Navigator.prototype, 'language', {
      configurable: true,
      get () {
        return culture;
      },
    });
    Object.defineProperty(Navigator.prototype, 'languages', {
      configurable: true,
      get () {
        return [culture];
      },
    });
  } catch {}
})();

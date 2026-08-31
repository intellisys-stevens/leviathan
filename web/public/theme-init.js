(() => {
  let theme = 'dark';
  try {
    if (window.localStorage.getItem('leviathan.theme.v1') === 'light') {
      theme = 'light';
    }
  } catch {
    // The dark default remains usable when browser storage is unavailable.
  }
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  themeColor?.setAttribute('content', theme === 'dark' ? '#09131f' : '#edf6f8');
})();

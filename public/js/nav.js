/* Shared behaviour of the single navigation menu (dashboard app and public verification page). */
(function () {
  'use strict';
  const header = document.querySelector('header.top');
  const toggle = document.getElementById('nav-toggle');
  if (!header || !toggle) return;
  const set = (open) => { header.classList.toggle('open', open); toggle.setAttribute('aria-expanded', String(open)); };
  toggle.addEventListener('click', () => set(!header.classList.contains('open')));
  // choosing a destination (or pressing Escape / clicking elsewhere) closes the menu
  header.addEventListener('click', (e) => { if (e.target.closest('nav a')) set(false); });
  document.addEventListener('click', (e) => { if (!header.contains(e.target)) set(false); }); // click elsewhere closes
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') set(false); });
})();

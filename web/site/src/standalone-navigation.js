import './styles/navigation.css';

// Standalone product pages use native scrolling and do not load the framed motion runtime.
const root = document.documentElement;
const nav = document.querySelector('[data-menu]');
const button = document.querySelector('[data-menu-opener]');
function setOpen(open) {
  root.classList.toggle('menu--opened', open);
  nav.inert = !open;
  nav.setAttribute('aria-hidden', String(!open));
  button.setAttribute('aria-expanded', String(open));
  button.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  (open ? nav.querySelector('a') : button)?.focus({ preventScroll: true });
}
button.addEventListener('click', () => setOpen(button.getAttribute('aria-expanded') !== 'true'));
document.addEventListener('keydown', event => {
  if (button.getAttribute('aria-expanded') !== 'true') return;
  if (event.key === 'Escape') setOpen(false);
  if (event.key === 'Tab') {
    const links = [...nav.querySelectorAll('a'), button];
    if (event.shiftKey && document.activeElement === links[0]) { event.preventDefault(); button.focus(); }
    else if (!event.shiftKey && document.activeElement === button) { event.preventDefault(); links[0].focus(); }
  }
});

// Native, one-shot motion. Content stays visible if animation support is unavailable.
const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
const running = new Map();
let observer;
const ease = 'cubic-bezier(.22,1,.36,1)';

function play(element, frames, options = {}) {
  if (!element || preference.matches || typeof element.animate !== 'function') return;
  running.get(element)?.cancel();
  const animation = element.animate(frames, { duration: 680, easing: ease, ...options });
  running.set(element, animation);
  const clear = () => { if (running.get(element) === animation) running.delete(element); };
  animation.onfinish = clear;
  animation.oncancel = clear;
}

function reveal(element, delay = 0) {
  play(element, [{ opacity: 0, transform: 'translateY(24px)' }, { opacity: 1, transform: 'translateY(0)' }], { delay, fill: 'backwards' });
}

function start() {
  if (preference.matches) return;
  document.querySelectorAll('.hero-line').forEach((line, index) => {
    play(line, [{ clipPath: 'inset(0 0 100% 0)', transform: 'translateY(30px)' }, { clipPath: 'inset(0 0 0 0)', transform: 'translateY(0)' }], { delay: 70 + index * 100, duration: 800, fill: 'backwards' });
  });
  ['.hero .eyebrow', '.hero .intro', '.hero .text-link', '.pledge'].forEach((selector, index) => reveal(document.querySelector(selector), index * 90));
  if (!('IntersectionObserver' in window)) return;
  const groups = '.section-heading, .fee-bar, .fee-cards, .flow-list li, .calculator-body, .principle-grid article, .status-list, .closing';
  observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const element = entry.target;
      observer.unobserve(element);
      if (element.matches('.fee-bar')) {
        play(element, [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: 1000 });
      } else if (element.matches('.fee-cards, .status-list')) {
        [...element.children].forEach((child, index) => reveal(child, index * 85));
      } else {
        reveal(element);
      }
    }
  }, { threshold: 0.12, rootMargin: '0px 0px -20px 0px' });
  document.querySelectorAll(groups).forEach(element => observer.observe(element));
}

function stop() {
  observer?.disconnect();
  for (const animation of running.values()) animation.cancel();
  running.clear();
}

// Update values immediately; animate their presentation, never an intermediate balance.
export function animateCalculation() {
  play(document.querySelector('.calculation-result'), [{ backgroundColor: '#ed571929', transform: 'translateY(4px)' }, { backgroundColor: 'transparent', transform: 'translateY(0)' }], { duration: 380 });
}

preference.addEventListener('change', event => { if (event.matches) stop(); });
window.addEventListener('pagehide', stop);
start();

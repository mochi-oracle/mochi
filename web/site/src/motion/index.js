import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { Observer } from 'gsap/Observer';
import Lenis from 'lenis';
import Swiper from 'swiper';
import { Controller, EffectCreative, EffectFade, Navigation } from 'swiper/modules';

gsap.registerPlugin(ScrollTrigger, Observer);

const root = document.documentElement;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ease = 'power3.inOut';
const elements = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const attr = (el, key, fallback) => el.dataset[key] ?? fallback;
const revealTweens = new Map();
let lenis = null;

function playVisibleReveals() {
  for (const [el, tween] of revealTweens) {
    const box = el.getBoundingClientRect();
    if (box.top < innerHeight && box.bottom > 0 && tween.progress() < 1) {
      el.classList.add('is-started');
      tween.play();
    }
  }
}

function bootSmoothScroll() {
  const wrapper = document.querySelector('[data-scroll-wrapper]');
  const content = document.querySelector('[data-scroller]');
  if (!wrapper || !content || reduced) return null;
  const lenis = new Lenis({ wrapper, content, smoothWheel: true, lerp: 0.1 });
  ScrollTrigger.defaults({ scroller: wrapper });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add(time => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
  return lenis;
}

// Back/Forward: the page scrolls inside [data-scroll-wrapper], which browsers do not restore. Remember the wrapper's
// position per URL for this tab and put it back when the history entry is revisited (not on fresh visits).
const scrollMemoryKey = () => `mochi:scroll:${location.pathname}${location.search}`;
function setupScrollMemory() {
  const wrapper = document.querySelector('[data-scroll-wrapper]');
  if (!wrapper) return;
  const save = () => { try { sessionStorage.setItem(scrollMemoryKey(), String(Math.round(wrapper.scrollTop))); } catch {} };
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
  const entry = performance.getEntriesByType?.('navigation')?.[0];
  const backForward = entry ? entry.type === 'back_forward' : performance.navigation?.type === 2;
  if (!backForward) return;
  let target = 0;
  try { target = Number(sessionStorage.getItem(scrollMemoryKey())) || 0; } catch {}
  if (target <= 0) return;
  // Fonts and late layout can shorten the first attempt; retry until it holds, unless the visitor scrolls first.
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  for (const type of ['wheel', 'touchstart', 'pointerdown']) wrapper.addEventListener(type, interrupt, { once: true, passive: true });
  window.addEventListener('keydown', interrupt, { once: true });
  const restore = () => {
    if (interrupted || Math.abs(wrapper.scrollTop - target) < 2) return;
    if (lenis) { lenis.resize(); lenis.scrollTo(target, { immediate: true, force: true }); } else wrapper.scrollTop = target;
  };
  restore();
  document.fonts?.ready.then(restore);
  window.addEventListener('load', restore, { once: true });
  return true;
}

// In-page links (#anchors) inside the custom scroller: scroll the wrapper itself and move focus to the target.
// restoring: Back/Forward is putting a remembered position back, so the initial deep-link jump is skipped.
function setupAnchors(restoring = false) {
  const wrapper = document.querySelector('[data-scroll-wrapper]');
  if (!wrapper) return;
  const navigate = hash => {
    let id;
    try { id = decodeURIComponent(hash.slice(1)); } catch { return; }
    const target = document.getElementById(id);
    if (!target || !wrapper.contains(target)) return;
    const offset = -parseFloat(getComputedStyle(target).scrollMarginTop || '0');
    // Native focus or scrollIntoView can move the wrapper before Lenis updates its cached position.
    const top = wrapper.scrollTop + target.getBoundingClientRect().top - wrapper.getBoundingClientRect().top + offset;
    if (lenis) lenis.scrollTo(top, { immediate: true, force: true });
    else wrapper.scrollTo({ top, behavior: 'instant' });
    target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  };
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.hasAttribute('download') || link.target) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin || url.pathname !== location.pathname || url.search !== location.search || !url.hash) return;
    event.preventDefault();
    history.pushState(null, '', url.hash);
    navigate(url.hash);
  });
  window.addEventListener('popstate', () => navigate(location.hash));
  window.addEventListener('hashchange', () => navigate(location.hash));
  // The loader's clip path can temporarily alter element geometry; align deep links after it clears.
  const initial = () => {
    if (root.classList.contains('preloader-complete')) {
      if (!restoring) document.fonts.ready.then(() => navigate(location.hash));
      observer.disconnect();
    }
  };
  const observer = new MutationObserver(initial);
  observer.observe(root, { attributes: true, attributeFilter: ['class'] });
  initial();
}

function setupLazyImages() {
  const images = elements('img[data-component^="lazyload"][data-src]');
  const load = image => {
    if (image.dataset.srcset) image.srcset = image.dataset.srcset;
    image.src = image.dataset.src;
    image.dataset.llStatus = 'loaded';
  };
  if (reduced || !('IntersectionObserver' in window)) { images.forEach(load); return; }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      load(entry.target);
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '250px 0px' });
  images.forEach(image => observer.observe(image));
}

// The splash plays once per browser: later page loads (and every page after the first) show the content at once.
// Storage can be unavailable (private modes, blocked cookies); then the splash simply plays.
const SPLASH_SEEN_KEY = 'mochi:splash-seen';
function splashSeen() {
  try { return localStorage.getItem(SPLASH_SEEN_KEY) === '1'; } catch { return false; }
}
function rememberSplash() {
  try { localStorage.setItem(SPLASH_SEEN_KEY, '1'); } catch {}
}

function finishLoader(loader) {
  root.classList.remove('is-loading');
  root.classList.add('preloader-complete');
  loader?.setAttribute('aria-hidden', 'true');
}

// Start the splash at DOM readiness; image downloads must not delay the animation.
function completeLoader() {
  root.classList.add('is-loaded');
  const loader = document.querySelector('[data-component="preloader"]');
  if (!loader) {
    finishLoader(null);
    playVisibleReveals();
    return;
  }
  const insets = elements('.preloader__layer-inset', loader);
  if (reduced || splashSeen()) {
    // Same end state as the timeline below: colour fills gone, frame bars and M/O labels in place.
    insets.forEach(inset => { inset.style.display = 'none'; });
    finishLoader(loader);
    if (!reduced) ScrollTrigger.refresh();
    playVisibleReveals();
    return;
  }
  rememberSplash();
  // The old zero-height clip would conceal the animated layers until completion.
  gsap.set(loader, { clipPath: 'none', transform: 'none' });
  const layers = elements('.preloader__layer', loader);
  const words = elements('.preloader__word', loader);
  gsap.set(words, { opacity: 1 });
  const timeline = gsap.timeline({ defaults: { ease }, onComplete: () => {
    finishLoader(loader);
    gsap.set('[data-page-overlay]', { clearProps: 'clipPath' });
    ScrollTrigger.refresh();
    ScrollTrigger.update();
    playVisibleReveals();
  }});
  // About 1.9 s in total (it was 4.8 s): the page is uncovered from about 1.4 s.
  timeline
    .fromTo(layers[0], { xPercent: -100 }, { xPercent: 0, duration: .7 }, 0)
    .fromTo(layers[1], { xPercent: -100 }, { xPercent: 0, duration: .7 }, .07)
    .fromTo(layers[2], { xPercent: -100 }, { xPercent: 0, duration: .7 }, .14)
    .call(() => root.classList.remove('is-loading'), [], .6)
    .fromTo('main', { visibility: 'hidden', clipPath: 'inset(50% 50% 0 50%)' }, { visibility: 'visible', clipPath: 'inset(0)', duration: .8, ease: 'power3.inOut', clearProps: 'clipPath' }, .6)
    .to(words, { opacity: 1, duration: .3, stagger: .06 }, .15)
    .fromTo('[data-page-overlay]', { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', duration: .45 }, .9)
    // Under the full overlay, the full-size colour fills go away. What stays of the layers is their
    // :before/:after bars: the permanent lavender/orange frame with the M and O labels.
    .set(insets, { display: 'none' })
    .to('[data-page-overlay]', { clipPath: 'inset(0 0 0 100%)', duration: .5, ease }, '+=.05')
    .add(() => gsap.set('[data-page-overlay]', { clearProps: 'clipPath' }));
}

function splitWords(el) {
  if (el.dataset.motionSplitReady) return elements('[data-motion-word]', el);
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) if (walker.currentNode.nodeValue.trim()) textNodes.push(walker.currentNode);
  for (const node of textNodes) {
    const fragment = document.createDocumentFragment();
    const tokens = node.nodeValue.split(/(\s+)/);
    for (const token of tokens) {
      if (!token || /^\s+$/.test(token)) { fragment.append(token); continue; }
      const span = document.createElement('span');
      span.dataset.motionWord = '';
      span.textContent = token;
      fragment.append(span);
    }
    node.replaceWith(fragment);
  }
  el.dataset.motionSplitReady = 'true';
  return elements('[data-motion-word]', el);
}

function visualWordLines(el) {
  const words = splitWords(el);
  const groups = [];
  for (const word of words) {
    const y = Math.round(word.getBoundingClientRect().top);
    let line = groups.find(group => group.y === y);
    if (!line) { line = { y, words: [] }; groups.push(line); }
    line.words.push(word);
  }
  return groups.map(group => group.words);
}

function wordsInVisualLines(el) {
  return visualWordLines(el).flat();
}

// Titles marked data-split="lines" are rebuilt as .line-w > .line wrappers, one per visual line, so each line can
// slide in and carry its own underline (.large-title-underline .line:after). A copy of the source nodes is kept so a
// resize can regroup words, including authored <br> breaks; nodes are cloned, never re-parsed from HTML.
const lineSources = new WeakMap();
function splitLines(el) {
  if (!lineSources.has(el)) lineSources.set(el, Array.from(el.childNodes, node => node.cloneNode(true)));
  else {
    el.replaceChildren(...lineSources.get(el).map(node => node.cloneNode(true)));
    delete el.dataset.motionSplitReady;
  }
  const groups = visualWordLines(el);
  if (elements('*', el).some(node => !node.matches('[data-motion-word], br'))) return [];
  el.textContent = '';
  return groups.map(words => {
    const wrap = document.createElement('div');
    wrap.className = 'line-w';
    const line = document.createElement('div');
    line.className = 'line';
    words.forEach((word, i) => { if (i) line.append(' '); line.append(word); });
    wrap.append(line);
    el.append(wrap);
    return line;
  });
}


// Scale reveals: axis and the edge each variant grows from.
const SCALE_VARIANTS = {
  scale: { axis: 'scale', origin: '50% 50%' },
  scaleRight: { axis: 'scaleX', origin: '0% 50%' },
  scaleLeft: { axis: 'scaleX', origin: '100% 50%' },
  scaleDown: { axis: 'scaleY', origin: '50% 0%' },
  scaleUp: { axis: 'scaleY', origin: '50% 100%' },
};

// data-start / data-end may use rem, vh or "full-height"; ScrollTrigger positions need px.
function scrollPosition(value, el) {
  if (value.includes('full-height')) return `+=${el.getBoundingClientRect().height}px`;
  const rootPx = parseFloat(getComputedStyle(root).fontSize) || 10;
  return value
    .replace(/(-?\d*\.?\d+)rem/g, (_, n) => `${Number(n) * rootPx}px`)
    .replace(/(-?\d*\.?\d+)vh/g, (_, n) => `${Number(n) * innerHeight / 100}px`);
}

function revealFromData(el) {
  const type = el.dataset.animation;
  const delay = Number(attr(el, 'delay', 0));
  const duration = Number(attr(el, 'duration', 1.1));
  const from = attr(el, 'from', 0);
  const to = attr(el, 'to', 1);
  const scrub = el.hasAttribute('data-scrub') ? Number(attr(el, 'scrub', 1)) || true : false;
  const scroll = type === 'parallax' || el.hasAttribute('data-start') || el.hasAttribute('data-trigger');
  const trigger = el.closest('[data-trigger]')?.dataset.trigger || attr(el, 'scrollTarget', null) || el;
  const common = { duration, delay, ease: attr(el, 'ease', 'power3.out'), overwrite: 'auto' };
  let tween;

  if (type === 'split' && el.dataset.split === 'lines') {
    const lines = splitLines(el);
    if (reduced || !lines.length) { el.classList.add('is-started'); if (lines.length) return; }
    if (lines.length) {
      tween = gsap.fromTo(lines, { yPercent: 100 }, { yPercent: 0, duration: Math.min(duration, .9), delay, stagger: .1, ease: 'power3.out' });
    }
  }
  if (tween) {
    // line split handled above
  } else if (type === 'split') {
    const words = wordsInVisualLines(el);
    if (reduced || !words.length) return;
    gsap.set(words, { display: 'inline-block', willChange: 'transform,opacity' });
    tween = gsap.fromTo(words, { yPercent: 120 }, {
      yPercent: 0, duration: Math.min(duration, .9), delay,
      stagger: Number(attr(el, 'staggerInterval', .1)), ease: 'power3.out', clearProps: 'willChange',
    });
  } else if (type === 'fade') {
    if (reduced) return;
    tween = gsap.fromTo(el, { opacity: 0, y: 24 }, { ...common, opacity: 1, y: 0, clearProps: 'transform,willChange' });
  } else if (type === 'moveUp') {
    if (reduced) return;
    tween = gsap.fromTo(el, { opacity: 0, yPercent: 35 }, { ...common, opacity: 1, yPercent: 0, clearProps: 'transform,willChange' });
  } else if (type === 'clip') {
    if (reduced) return;
    tween = gsap.fromTo(el, { clipPath: from }, { ...common, clipPath: to, clearProps: 'clipPath' });
  } else if (type in SCALE_VARIANTS) {
    if (reduced) return;
    const { axis, origin } = SCALE_VARIANTS[type];
    tween = gsap.fromTo(el, { [axis]: Number(from), transformOrigin: origin }, { ...common, [axis]: Number(to), transformOrigin: origin, clearProps: axis, onComplete: () => {
      el.classList.remove('scale-y-0', 'scale-x-0', 'scale-0');
      gsap.set(el, { clearProps: 'transform' });
    }});
  } else if (type === 'parallax') {
    // Desktop only (>= 1280px). Travel = scroll target height x speed x 0.1, from data-start-at (else -travel)
    // to data-stop-at (else +travel), scrubbed over the element's start/end range.
    if (reduced || !window.matchMedia('(min-width: 1280px)').matches) return;
    const speed = Number(attr(el, 'scrollSpeed', 1)) || 1;
    const target = el.dataset.scrollTarget ? document.querySelector(el.dataset.scrollTarget) : el.parentNode;
    const travel = () => target.getBoundingClientRect().height * speed * .1;
    const fromY = () => (el.hasAttribute('data-start-at') ? Number(el.dataset.startAt) : -travel());
    const toY = () => (el.hasAttribute('data-stop-at') ? Number(el.dataset.stopAt) : travel());
    gsap.set(el, { y: fromY() });
    tween = gsap.fromTo(el, { y: fromY }, { y: toY, ease: 'none', scrollTrigger: { trigger: target, start: attr(el, 'start', 'top bottom'), end: attr(el, 'end', 'bottom top'), scrub: true, invalidateOnRefresh: true } });
  } else if (type === 'logo-reveal') {
    if (reduced) return;
    // clamp(): on tall phones the wordmark's top never reaches 85% of the scroller, even at maximum scroll.
    tween = gsap.fromTo(el, { clipPath: 'inset(100% 0 0)' }, { ...common, clipPath: 'inset(0% 0 0)', scrollTrigger: { trigger: el, start: 'clamp(top 85%)', once: true } });
  } else if (type === 'ambient-move') {
    if (!reduced) setupAmbientMove(el);
  }

  if (!tween) return;
  if (type !== 'parallax' && type !== 'ambient-move' && type !== 'logo-reveal') {
    const onComplete = tween.eventCallback('onComplete');
    tween.eventCallback('onComplete', () => {
      onComplete?.();
      el.classList.add('is-complete');
    });
    revealTweens.set(el, tween);
    tween.pause();
    const triggerConfig = {
      trigger,
      start: scrollPosition(attr(el, 'start', 'top bottom'), el),
      end: scrollPosition(attr(el, 'end', 'bottom top'), el),
      once: !el.hasAttribute('data-repeat'),
      onEnter: () => { el.classList.add('is-started'); tween.play(); },
      onEnterBack: () => { if (el.dataset.noReset === undefined) { el.classList.add('is-started'); tween.restart(); } },
      onLeave: () => { if (el.hasAttribute('data-repeat')) el.classList.remove('is-started', 'is-complete'); },
    };
    ScrollTrigger.create(triggerConfig);
  }
}

function setupReveals() {
  if (reduced) {
    root.classList.add('mochi-reduced-motion');
    elements('[data-animation]').forEach(el => { el.style.opacity = '1'; el.style.visibility = 'visible'; el.style.clipPath = 'none'; el.style.transform = 'none'; });
    return;
  }
  elements('[data-animation]').filter(el => !el.closest('[hidden]')).forEach(el => {
    const box = el.getBoundingClientRect();
    const continuous = ['parallax', 'ambient-move'].includes(el.dataset.animation);
    // Do not hide content the visitor has already seen while fonts and motion initialize.
    if (!continuous && box.top < innerHeight && box.bottom > 0) {
      el.classList.remove('scale-y-0', 'scale-x-0', 'scale-0');
      el.classList.add('is-started', 'is-complete');
      return;
    }
    revealFromData(el);
  });
}

function setupMenu() {
  const nav = document.querySelector('[data-menu]');
  const button = document.querySelector('[data-menu-opener]');
  if (!nav || !button) return;
  let open = false;
  const items = elements('[data-stagger]', nav);
  const setMenu = next => {
    if (open === next) return;
    open = next;
    root.classList.toggle('menu--opened', open);
    // The frame strips around the menu sit over the scroller; keep the page underneath still while the menu is open
    // (fixes.css also locks the wrapper's overflow for native and touch scrolling).
    if (open) lenis?.stop(); else lenis?.start();
    nav.classList.toggle('mochi-menu-open', open && root.classList.contains('dashboard-document'));
    nav.inert = !open;
    nav.setAttribute('aria-hidden', String(!open));
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    if (reduced) {
      gsap.set(nav, { clipPath: open ? 'inset(0)' : 'inset(0 0 100% 0)' });
      gsap.set(items, { clearProps: 'all' });
      return;
    }
    if (open) {
      gsap.fromTo(items, { yPercent: 110, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 1.2, delay: .25, stagger: .1, ease: 'power3.out', clearProps: 'all' });
      nav.querySelector('a[href]')?.focus({ preventScroll: true });
    } else {
      gsap.to(items, { yPercent: -40, opacity: 0, duration: .45, stagger: .035, ease: 'power2.in', clearProps: 'all' });
      button.focus({ preventScroll: true });
    }
  };
  button.addEventListener('click', () => setMenu(!open));
  document.addEventListener('click', event => { if (open && !nav.contains(event.target) && !button.contains(event.target)) setMenu(false); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && open) setMenu(false); });
  if (nav.classList.contains('mochi-menu-open')) setMenu(true);
}

function setupCarousels() {
  const contentCarousels = elements('[data-content-carousel]');
  const linkedImages = new Set();
  for (const content of contentCarousels) {
    const holder = content.closest('section') || document;
    const images = holder.querySelector('[data-images-carousel]');
    const imageSwiper = images && !images.swiper ? new Swiper(images, {
      modules: [Controller, EffectCreative],
      slidesPerView: 1,
      simulateTouch: false,
      allowTouchMove: false,
      direction: 'vertical',
      grabCursor: false,
      effect: 'creative',
      creativeEffect: { prev: { translate: [0, '-10%', -1] }, next: { translate: [0, '100%', 0] } },
    }) : images?.swiper;
    if (images) linkedImages.add(images);
    const nextEl = holder.querySelector('[data-carousel-control="next"]');
    const prevEl = holder.querySelector('[data-carousel-control="prev"]');
    const contentSwiper = content.swiper || new Swiper(content, {
      modules: [Controller, EffectFade, Navigation],
      // Reduced motion: switch slides without the 1.2 s cross-fade.
      speed: reduced ? 0 : 1200,
      slidesPerView: 1,
      simulateTouch: false,
      allowTouchMove: false,
      effect: 'fade',
      // Without crossFade Swiper keeps earlier slides at full opacity under the active one, so their text and links
      // pile up after "Next".
      fadeEffect: { crossFade: true },
      preventInteractionOnTransition: true,
      navigation: nextEl && prevEl ? { nextEl, prevEl } : undefined,
      controller: imageSwiper ? { control: imageSwiper } : undefined,
    });
    if (imageSwiper && contentSwiper.controller && contentSwiper.controller.control !== imageSwiper) contentSwiper.controller.control = imageSwiper;
    const current = holder.querySelector('[data-carousel-control="current"]');
    const total = holder.querySelector('[data-carousel-control="total"]');
    const updateCounter = () => {
      if (current) current.textContent = String(contentSwiper.realIndex + 1).padStart(2, '0');
      if (total) total.textContent = String(contentSwiper.slides.length).padStart(2, '0');
    };
    updateCounter();
    contentSwiper.on('slideChange', updateCounter);
    // Reduced motion: no word-by-word exit and entrance; the slide text simply changes with the slide.
    if (reduced) continue;
    const slideText = elements('.swiper-slide', content).map(slide => elements('[data-text]', slide).flatMap(visualWordLines));
    const animateText = direction => {
      const previous = slideText[contentSwiper.previousIndex] || [];
      const nextSlide = slideText[contentSwiper.activeIndex] || [];
      gsap.fromTo(previous.flat(), { yPercent: 0 }, { yPercent: direction === 'next' ? -120 : 120, ease: 'power2.in', duration: .35, stagger: .05 });
      gsap.fromTo(nextSlide.flat(), { yPercent: direction === 'next' ? 120 : -120 }, { yPercent: 0, ease: 'power3.out', duration: .85, delay: .4, stagger: .05 });
    };
    contentSwiper.on('slideNextTransitionStart', () => animateText('next'));
    contentSwiper.on('slidePrevTransitionStart', () => animateText('prev'));
  }
  for (const images of elements('[data-images-carousel]')) {
    if (linkedImages.has(images) || images.swiper) continue;
    new Swiper(images, {
      modules: [Controller, EffectCreative],
      slidesPerView: 1,
      simulateTouch: false,
      allowTouchMove: false,
      direction: 'vertical',
      effect: 'creative',
      creativeEffect: { prev: { translate: [0, '-10%', -1] }, next: { translate: [0, '100%', 0] } },
    });
  }
}

function setupLoadMore() {
  const items = elements('[data-load-more-item]');
  const button = document.querySelector('[data-load-more-trigger]');
  if (!items.length || !button) return;
  const hiddenItems = items.filter(item => item.classList.contains('hidden') || item.hidden);
  if (!hiddenItems.length) { button.remove(); return; }
  button.classList.remove('hidden');
  button.addEventListener('click', () => {
    if (reduced) hiddenItems.forEach(item => item.classList.remove('hidden'));
    else gsap.fromTo(hiddenItems, { y: 50, opacity: 0 }, { y: 0, opacity: 1, ease: 'power3.out', stagger: .1, onComplete: () => ScrollTrigger.refresh() });
    hiddenItems.forEach(item => item.classList.remove('hidden'));
    button.remove();
  });
}

function setupPopups() {
  const overlay = document.querySelector('[data-popup-overlay]');
  const close = popup => {
    popup.classList.remove('is-active');
    root.classList.remove('popup--is-active');
    if (overlay) overlay.classList.remove('is-active');
  };
  for (const opener of elements('[data-popup-toggle]')) {
    opener.addEventListener('click', () => {
      const popup = document.getElementById(opener.dataset.popupToggle);
      if (!popup) return;
      popup.classList.add('is-active');
      root.classList.add('popup--is-active');
      overlay?.classList.add('is-active');
      popup.querySelector('[data-popup-close]')?.focus({ preventScroll: true });
    });
  }
  elements('[data-popup-close]').forEach(button => button.addEventListener('click', () => {
    const popup = button.closest('[data-component="popup"]');
    if (popup) close(popup);
  }));
  overlay?.addEventListener('click', () => {
    const popup = document.querySelector('[data-component="popup"].is-active');
    if (popup) close(popup);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      const popup = document.querySelector('[data-component="popup"].is-active');
      if (popup) close(popup);
    }
  });
}

// Pointer-driven drift of [data-ambient-box] layers while the section is in view. Smoothed pointer position
// (lerp 0.1 per frame) maps to +/- movement (data-ambient-movement, default 0.5% of the viewport width); at rest
// (pointer centred or absent) every layer sits at 0.
const pointer = { x: .5, y: .5 };
window.addEventListener('pointermove', event => { pointer.x = event.clientX / innerWidth; pointer.y = event.clientY / innerHeight; }, { passive: true });
function setupAmbientMove(section) {
  const boxes = elements('[data-ambient-box]', section);
  if (!boxes.length) return;
  const directions = section.dataset.ambientDirection || 'x,y';
  const amount = () => Number(section.dataset.ambientMovement) || .005 * innerWidth;
  const smooth = { x: .5, y: .5 };
  let active = false;
  ScrollTrigger.create({ trigger: section, start: 'top bottom', end: 'bottom top', onToggle: self => { active = self.isActive; } });
  const movers = boxes.map(box => ({ x: gsap.quickTo(box, 'x', { duration: .5, ease: 'power2' }), y: gsap.quickTo(box, 'y', { duration: .5, ease: 'power2' }) }));
  const range = gsap.utils.mapRange;
  gsap.ticker.add(() => {
    if (!active) return;
    smooth.x += (pointer.x - smooth.x) * .1;
    smooth.y += (pointer.y - smooth.y) * .1;
    const t = amount();
    const targets = [
      { x: range(0, 1, t, -t, smooth.x), y: range(0, 1, t, -t, smooth.y) },
      { x: range(0, 1, -2 * t, 2 * t, smooth.x), y: range(0, 1, -t, t, smooth.x) },
      { x: range(0, 1, -t, t, smooth.x), y: range(0, 1, t, -t, smooth.y) },
    ];
    movers.forEach((move, i) => {
      const value = targets[i] || targets[0];
      if (directions.includes('x')) move.x(value.x);
      if (directions.includes('y')) move.y(value.y);
    });
  });
}

function setupAmbient() {
  const section = document.querySelector('[data-ambient-direction]');
  if (!section || reduced) return;
  const boxes = elements('[data-ambient-box]', section);
  section.addEventListener('pointermove', event => {
    const rect = section.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - .5;
    const y = (event.clientY - rect.top) / rect.height - .5;
    boxes.forEach((box, index) => gsap.to(box, { x: x * (index + 1) * 8, y: y * (index + 1) * 5, duration: .7, ease: 'power2.out', overwrite: 'auto' }));
  }, { passive: true });
}

function setupStackHover() {
  for (const block of elements('[data-animation="tech-stack"] [data-block]')) {
    block.addEventListener('mouseenter', () => {
      elements('[data-block]', block.closest('[data-animation="tech-stack"]')).forEach(el => el.classList.toggle('is--active', el === block));
      elements('[data-stack] g', block.closest('[data-animation="tech-stack"]')).forEach(el => el.classList.toggle('is--active', el.dataset.block === block.dataset.block));
    });
  }
}

function setupPortfolioHover() {
  const works = elements('[data-portfolio-work]');
  for (const work of works) {
    work.addEventListener('mouseenter', () => {
      const target = document.querySelector(`[data-portfolio-image="${CSS.escape(work.dataset.portfolioWork)}"]`);
      works.forEach(item => item.classList.toggle('is--active', item === work));
      elements('[data-portfolio-image]').forEach(image => image.classList.toggle('is-active', image === target));
    });
  }
}

function setupAccordions() {
  for (const opener of elements('[data-accordion-opener]')) {
    opener.addEventListener('click', () => {
      const item = opener.closest('[data-accordion-item]');
      const content = item?.querySelector('[data-accordion-content]');
      const active = item?.classList.toggle('is-active');
      opener.setAttribute('aria-expanded', String(Boolean(active)));
      if (!content || reduced) return;
      gsap.to(content, { height: active ? 'auto' : 0, duration: .65, ease });
    });
  }
}

function setupCursor() {
  const cursor = document.querySelector('.cursor');
  if (!cursor || reduced) return;
  window.addEventListener('pointermove', event => {
    root.style.setProperty('--cursor-x', String(event.clientX / innerWidth));
    root.style.setProperty('--cursor-y', String(event.clientY / innerHeight));
  }, { passive: true });
  document.addEventListener('pointerover', event => { if (event.target.closest('a,button,[data-portfolio-work]')) root.classList.add('cursor-active'); });
  document.addEventListener('pointerout', event => { if (event.target.closest('a,button,[data-portfolio-work]')) root.classList.remove('cursor-active'); });
}

function init() {
  if (!document.querySelector('#home, #about-mochi')) root.classList.add('inner-page');
  lenis = bootSmoothScroll();
  setupAnchors(setupScrollMemory());
  setupLazyImages();
  setupLoadMore();
  document.fonts.ready.then(() => { setupReveals(); ScrollTrigger.refresh(); });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      for (const el of elements('[data-split="lines"]')) {
        revealTweens.get(el)?.progress(1).kill();
        const lines = splitLines(el);
        gsap.set(lines, { yPercent: 0 });
        el.classList.add('is-started');
      }
      ScrollTrigger.refresh();
    }, 250);
  });
  setupMenu();
  setupCarousels();
  setupStackHover();
  setupPortfolioHover();
  setupAccordions();
  setupPopups();
  setupCursor();
  completeLoader();
  window.addEventListener('load', () => ScrollTrigger.refresh(), { once: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();

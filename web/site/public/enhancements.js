/* Small accessibility and reduced-motion bridge around the preserved reference runtime. */
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
if(reduced) document.documentElement.classList.add('mochi-reduced-motion');
document.addEventListener('keydown',e=>{
 const el=e.target;
 if((e.key==='Enter'||e.key===' ')&&el.matches('[role="button"],[role="link"]')){e.preventDefault();el.click()}
 if(e.key==='Escape'){
  if(window.app?.navigation?.isActive)window.app.navigation.hide();
  const close=document.querySelector('[data-component="popup"].is-active [data-popup-close]');close?.click();
 }
});
const menuButton=document.querySelector('[data-menu-opener]');
const nav=document.querySelector('[data-menu]');
function reflectMenu(open){
 if(!nav||!menuButton)return;
 nav.inert=!open;nav.setAttribute('aria-hidden',String(!open));
 menuButton.setAttribute('aria-expanded',String(open));
 menuButton.setAttribute('aria-label',open?'Close navigation':'Open navigation');
}
reflectMenu(false);
// The floating mark follows the surface beneath it, including white content sections.
const floatingMarks=[...document.querySelectorAll('.mochi-mark image')].filter(image=>!image.closest('[data-component="preloader"]'));
for(const image of floatingMarks)image.parentElement.parentElement.classList.add('mochi-navmark');
let inkFrame=0;
function updateLogoInk(){
 inkFrame=0;
 const expanded=document.documentElement.classList.contains('menu--opened');
 for(const image of floatingMarks){
  const rect=image.parentElement.getBoundingClientRect();
  const y=rect.top+rect.height/2;
  const section=[...document.querySelectorAll('main section,footer')].find(el=>{const r=el.getBoundingClientRect();return r.top<=y&&r.bottom>y});
  const onLight=!expanded&&section?.classList.contains('bg-white');
  const next=onLight?'/assets/brand/logo-pink.svg':'/assets/brand/logo-transparent.svg';
  if(image.getAttribute('href')!==next)image.setAttribute('href',next);
 }
}
function scheduleLogoInk(){if(!inkFrame)inkFrame=requestAnimationFrame(updateLogoInk)}
document.querySelector('[data-scroll-wrapper]')?.addEventListener('scroll',scheduleLogoInk,{passive:true});
window.addEventListener('resize',scheduleLogoInk);
new MutationObserver(scheduleLogoInk).observe(document.documentElement,{attributes:true,attributeFilter:['class']});
updateLogoInk();
if(document.documentElement.classList.contains('dashboard-document')){
 menuButton?.addEventListener('click',()=>{const open=nav.classList.toggle('mochi-menu-open');reflectMenu(open);if(open)nav.querySelector('a')?.focus();});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'){nav?.classList.remove('mochi-menu-open');reflectMenu(false);menuButton?.focus()}});
}else{
 const update=()=>reflectMenu(document.documentElement.classList.contains('menu--opened'));
 new MutationObserver(update).observe(document.documentElement,{attributes:true,attributeFilter:['class']});
 window.addEventListener('load',()=>{if(location.hash)setTimeout(()=>{
  const target=document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if(target)target.scrollIntoView({behavior:'instant',block:'start'});
 },1800)},{once:true});
}
document.addEventListener('keydown',e=>{
 if(e.key!=='Tab'||menuButton?.getAttribute('aria-expanded')!=='true')return;
 const links=[...nav.querySelectorAll('a[href]'),menuButton];
 if(e.shiftKey&&document.activeElement===links[0]){e.preventDefault();links.at(-1).focus()}
 else if(!e.shiftKey&&document.activeElement===links.at(-1)){e.preventDefault();links[0].focus()}
});

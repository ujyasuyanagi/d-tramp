#!/usr/bin/env node
// Browser regression checks for the redesign; GraphQL is stubbed, no running backend required.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
mkdirSync(new URL('../docs/screenshots/', import.meta.url), { recursive: true });
const assetDir = new URL('../services/web/dist/assets/', import.meta.url);
const assets = readdirSync(assetDir);
const css = readFileSync(new URL(assets.find(x => x.endsWith('.css')), assetDir), 'utf8');
const js = readFileSync(new URL(assets.find(x => x.endsWith('.js')), assetDir), 'utf8').replaceAll('"/assets/', '"' + assetDir.href);
const sourceHtml = readFileSync(new URL('../services/web/dist/index.html', import.meta.url), 'utf8');
const html = sourceHtml.replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/, () => `<script type="module">${js.replaceAll('</script', '<\\/script')}</script>`).replace(/<link rel="stylesheet"[^>]*>/, () => `<style>${css}</style>`);
writeFileSync('/tmp/dtramp-redesign-preview.html', html);
const url = 'file:///tmp/dtramp-redesign-preview.html';
const chrome = spawn(process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell`, ['--no-sandbox', '--disable-gpu', '--remote-debugging-pipe', '--allow-file-access-from-files', '--user-data-dir=/tmp/dtramp-redesign-browser', 'about:blank'], { stdio: ['ignore','ignore','pipe','pipe','pipe'] });
let sessionId; let seq = 0; const pending = new Map(); const errors = []; let count = 0; let buffer = '';
chrome.stdio[4].on('data', chunk => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf('\0')) >= 0) {
    const raw = buffer.slice(0, end); buffer = buffer.slice(end+1);
    if(!raw) continue;
    const m = JSON.parse(raw);
    if(m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
    if(pending.has(m.id)) { const p=pending.get(m.id); pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); }
  }
});
let chromeError = '';
chrome.stderr.on('data', chunk => { chromeError += chunk.toString(); });
function failPending(error) { for (const p of pending.values()) p.reject(error); pending.clear(); }
chrome.on('error', failPending);
chrome.on('exit', (code, signal) => failPending(Error(`Chrome exited (${code ?? signal}): ${chromeError.trim()}`)));
chrome.stdio[3].on('error', failPending);
chrome.stdio[4].on('error', failPending);
function send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0'); }); }
async function evaluate(expression) { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description); return r.result.value; }
async function check(name, expression) { if (!await evaluate(expression)) throw Error(name); console.log(`✓ ${name}`); count++; }
async function waitFor(expression) { for (let i = 0; i < 80; i++) { if (await evaluate(expression)) return; await sleep(100); } throw Error(`Timeout: ${expression}`); }
async function shot(name) { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(new URL(`../docs/screenshots/redesign-${name}.png`, import.meta.url), Buffer.from(r.data, 'base64')); }
const fixture = `(() => {
  const originalFetch = window.fetch;
  const user = {id:'user-1',name:'Александр',email:'test@example.com',role:'PASSENGER',rating:4.9,tripsCount:12};
  const trips = [{id:'trip-1',driverId:'driver-1',driver:{...user,name:'Михаил'},from:{name:'Москва',lat:55.75,lon:37.61},to:{name:'Тверь',lat:56.85,lon:35.91},dateTime:'2026-11-02T09:00:00Z',seatsTotal:4,seatsAvailable:3,price:850,distanceKm:183,status:'SCHEDULED',comment:'Едем спокойно, с одной остановкой на кофе.'}];
  window.fetch = async (input, options) => {
    if (input !== '/graphql') return originalFetch(input, options);
    const {query, variables} = JSON.parse(options.body); let data;
    if(query.includes('driversNear(')) data = {driversNear:{drivers: window.__hideDrivers ? [] : [{id:'map-1',name:'Алексей',car:{model:'Toyota Camry',plate:'А123АА777',regionLabel:'Москва'},rating:4.8,lat:55.7558,lon:37.6173,status:window.__busyDriver ? 'BUSY' : 'FREE',pricePerKm:25,freeRide:false,speedKmh:40,distanceKm:1.2},{id:'map-2',name:'Мария',car:{model:'Ford Focus',plate:'В456ВВ750'},rating:4.9,lat:55.76,lon:37.63,status:'FREE',pricePerKm:20,freeRide:false,speedKmh:40,distanceKm:2}],radiusKm:3}};
    else if(query.includes('bookTrip(')) { window.__booked = variables; data = {bookTrip:{id:'booking-1',tripId:variables.tripId,userId:user.id,seats:variables.seats,priceTotal:850,status:'CONFIRMED'}}; }
    else if(query.includes('trips(')) data = {trips:window.__empty ? [] : trips};
    else if(query.includes('login(')) data = {login:{token:'fixture-token',user}};
    else if(query.includes('register(')) data = {register:{token:'fixture-token',user}};
    else if(query.includes('bookings {')) data = {bookings:[]};
    else if(query.includes('myTrips {')) data = {myTrips:[]};
    else if(query.includes('rides {')) data = {rides:[]};
    else if(query.includes('me {')) data = {me:user};
    else if(query.includes('roadRoute(')) data = {roadRoute:null};
    return new Response(JSON.stringify({data}),{status:200,headers:{'content-type':'application/json'}});
  };
})();`;
try {
  const { targetId } = await send('Target.createTarget', {url:'about:blank'});
  const attached = await send('Target.attachToTarget', {targetId, flatten:true}); sessionId = attached.sessionId;
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument',{source:fixture});
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});
  await send('Page.navigate',{url}); await waitFor(`!!document.querySelector('.trip-card')`);
  await evaluate(`localStorage.clear()`); await send('Page.reload'); await waitFor(`!!document.querySelector('.trip-card')`);
  await check('System light theme and guest search', `document.documentElement.dataset.theme === 'light' && !document.querySelector('dialog').open && !!document.querySelector('.search-submit')`);
  await check('Desktop panel is left of map centre', `document.querySelector('.panel').getBoundingClientRect().right < innerWidth/2`);
  await shot('desktop-light');
  await waitFor(`!!document.querySelector('.car-marker')`);
  await evaluate(`document.querySelector('.car-marker[title="А123АА777"]').click()`);
  await waitFor(`!!document.querySelector('.driver-panel')`);
  await check('Marker opens driver and vehicle panel on right', `document.querySelector('.driver-panel').getBoundingClientRect().left > innerWidth / 2 && document.querySelector('.driver-panel').innerText.includes('Алексей') && !document.querySelector('.leaflet-popup')`);
  await waitFor(`document.querySelector('.driver-photo img')?.naturalWidth > 0`);
  await shot('vehicle-desktop');
  await evaluate(`window.__busyDriver=true`);
  await waitFor(`document.querySelector('.vehicle-status').innerText.includes('Занята')`);
  await check('Vehicle status stays live during polling', `document.querySelector('.vehicle-status').innerText.includes('Занята')`);
  await evaluate(`document.querySelector('.car-marker[title="В456ВВ750"]').click()`);
  await waitFor(`document.querySelector('.driver-panel').innerText.includes('Мария')`);
  await check('Unknown model displays placeholder', `!!document.querySelector('.driver-photo-empty') && !document.querySelector('.driver-photo img')`);
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});
  await waitFor(`!document.querySelector('.driver-panel')`);

  await evaluate(`document.querySelector('.theme-toggle').click()`);
  await check('Theme toggle persists', `document.documentElement.dataset.theme === 'dark' && localStorage.getItem('dtramp.theme') === 'dark'`);
  await send('Page.reload'); await waitFor(`!!document.querySelector('.trip-card')`);
  await check('Theme survives reload', `document.documentElement.dataset.theme === 'dark'`);
  await shot('desktop-dark');
  await evaluate(`document.querySelector('#from').value='Москва'; document.querySelector('#from').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#to').value='Тверь'; document.querySelector('#to').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('.swap-button').click()`);
  await check('Swap route cities', `document.querySelector('#from').value === 'Тверь' && document.querySelector('#to').value === 'Москва'`);
  await evaluate(`document.querySelector('.book-button').click()`); await waitFor(`document.querySelector('dialog').open`);
  await check('Guest booking opens login, without booking', `!!document.querySelector('.selected-trip') && !window.__booked`);
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'}); await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});
  await waitFor(`!document.querySelector('dialog').open`);
  await evaluate(`document.querySelector('.book-button').click()`); await waitFor(`document.querySelector('dialog').open`);
  await evaluate(`document.querySelector('#email').value='test@example.com'; document.querySelector('#email').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#password').value='password123'; document.querySelector('#password').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('dialog form').requestSubmit()`);
  await waitFor(`!document.querySelector('dialog').open && !!document.querySelector('.account-button')`);
  await check('Login retains selected trip without automatic purchase', `!!document.querySelector('.selected-trip') && !window.__booked && document.querySelector('#from').value === 'Тверь'`);
  await evaluate(`document.querySelector('.book-button').click()`); await waitFor(`!!window.__booked`);
  await check('Explicit confirmation books selected trip', `window.__booked.tripId === 'trip-1' && window.__booked.seats === 1`);
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true}); await sleep(350);
  await check('Mobile bottom sheet and no document overflow', `document.querySelector('.panel').getBoundingClientRect().bottom <= innerHeight+1 && document.documentElement.scrollWidth <= innerWidth`);
  await shot('mobile-dark');
  await evaluate(`document.querySelector('.car-marker[title="А123АА777"]').click()`);
  await waitFor(`!!document.querySelector('.driver-panel')`);
  await check('Mobile vehicle details fit viewport', `document.querySelector('.driver-panel').getBoundingClientRect().left >= 0 && document.querySelector('.driver-panel').getBoundingClientRect().right <= innerWidth`);
  await shot('vehicle-mobile');
  await evaluate(`document.querySelector('.driver-panel .close-button').click()`);
  await waitFor(`!document.querySelector('.driver-panel')`);

  await evaluate(`document.querySelector('.sheet-handle button').click()`); await sleep(350);
  await check('Expand sheet', `document.querySelector('.panel').classList.contains('sheet-2') && document.querySelector('.panel-content').clientHeight > 300`);
  await evaluate(`document.querySelector('.sheet-handle button').click()`); await sleep(350);
  await check('Collapse sheet preserves map', `document.querySelector('.panel').classList.contains('sheet-0') && document.querySelector('.panel').clientHeight < 110`);
  // Real pointer drag on handle: must advance exactly one state, without a following click advancing again.
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:190,y:758,button:'left',clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:190,y:640,button:'left',buttons:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:190,y:640,button:'left',clickCount:1}); await sleep(350);
  await check('Handle drag advances one sheet position', `document.querySelector('.panel').classList.contains('sheet-1')`);
  await evaluate(`document.querySelector('.theme-toggle').click()`); await shot('mobile-light');
  await evaluate(`document.querySelectorAll('.tabs button')[1].click()`); await sleep(100);
  await evaluate(`document.querySelector('[data-pick="rideDest"]').click()`); await sleep(350);
  await check('Map picking collapses sheet', `document.querySelector('.panel').classList.contains('sheet-0') && !!document.querySelector('.pick-instruction')`);
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:180,y:280,button:'left',clickCount:1}); await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:180,y:280,button:'left',clickCount:1}); await sleep(350);
  await check('Map picking returns to form with destination', `document.querySelector('.panel').classList.contains('sheet-1') && !document.querySelector('.pick-instruction') && document.querySelector('[data-field="rideDest"]').value !== 'не выбрана'`);
  for (const width of [320, 360, 760, 768, 1024]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<=760}); await sleep(300);
    await check(`No horizontal overflow at ${width}px`, `document.documentElement.scrollWidth <= innerWidth && document.querySelector('.panel').scrollWidth <= document.querySelector('.panel').clientWidth+1`);
  }
  await evaluate(`document.querySelectorAll('.tabs button')[2].click()`); await sleep(200);
  await check('My trips panel available', `document.querySelector('.panel-content').innerText.includes('Мои брони')`);
  await evaluate(`document.querySelectorAll('.tabs button')[0].click()`); await sleep(200);
  await evaluate(`window.__empty=true; document.querySelector('.search-card').requestSubmit()`); await waitFor(`!!document.querySelector('.empty')`);
  await check('Empty search state', `document.querySelector('.empty').innerText.includes('Ваша попутка')`);
  if(errors.length) throw Error(JSON.stringify(errors)); console.log(`Passed ${count} checks; no browser exceptions.`);
} catch (error) { console.error(error.message); process.exitCode = 1; } finally { chrome.kill(); }

#!/usr/bin/env node
/**
 * Проверка UI D-Tramp в реальном браузере через DevTools Protocol.
 * Прогоняет сценарий гостя и пользователя и сохраняет скриншоты в docs/screenshots.
 *
 *   node scripts/ui-check.mjs [--url http://localhost:8080/] [--chrome <путь к бинарнику>]
 *
 * Без аргументов берёт chrome-headless-shell из кэша Playwright.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const APP_URL = process.env.APP_URL ?? 'http://localhost:8080/';
const START_LAT = Number(process.env.START_LAT ?? 55.7558);
const DEBUG_PORT = 9333;
const OUT_DIR = new URL('../docs/screenshots', import.meta.url).pathname;
const CHROME =
  process.env.CHROME ??
  `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell`;

const chrome = spawn(
  CHROME,
  [
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    // Headless Chrome уважает системный прокси (GNOME), а тот пропускает только loopback:
    // без этого флага адреса docker/minikube (172.x, 192.168.x) открываются пустой страницей.
    '--proxy-server=direct://',
    '--proxy-bypass-list=*',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
chrome.stderr.on('data', () => {});

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` → ${detail ?? ''}`}`);
  if (ok) passed += 1;
  else failed += 1;
}

async function waitFor(check_, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check_()) return true;
    await sleep(250);
  }
  return false;
}

let socket;
let nextId = 1;
const pending = new Map();
const pageErrors = [];

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'ошибка в странице');
  return result.result.value;
}

async function openPage(url) {
  const target = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then((r) =>
    r.json(),
  );
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') {
      pageErrors.push(message.params.exceptionDetails?.exception?.description ?? 'exception');
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      pageErrors.push(message.params.args?.map((arg) => arg.value ?? arg.description ?? '').join(' '));
    }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
}

const helpers = `
  window.__ui = {
    byText(tag, text) {
      return [...document.querySelectorAll(tag)].find((el) => el.innerText.trim().includes(text));
    },
    clickText(tag, text) {
      const el = this.byText(tag, text);
      if (!el) return false;
      el.click();
      return true;
    },
    fill(id, value) {
      const el = document.getElementById(id);
      if (!el) return false;
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    /** Кнопка «На карте» у конкретной точки: их в панели две и различаются они только назначением. */
    pick(target) {
      const el = document.querySelector('[data-pick="' + target + '"]');
      if (!el) return false;
      el.click();
      return true;
    },
    fieldOf(target) {
      return document.querySelector('[data-field="' + target + '"]')?.value ?? '';
    },
    /** Значение поля точки: «55.7600, 37.6100», когда точка выбрана кликом, а не заголовок по умолчанию. */
    pointField(target) {
      const value = this.fieldOf(target);
      return /^[0-9]/.test(value) ? value : '';
    },
    text() { return document.body.innerText; },
    // в JWT лежит email вошедшего: так проверка видит, что это именно новый аккаунт, а не гость прошлого прогона
    sessionEmail() {
      const token = localStorage.getItem('dtramp.token');
      if (!token) return null;
      try { return JSON.parse(atob(token.split('.')[1])).email ?? null; } catch { return null; }
    },
    routeVertexCount(color) {
      // радиус поиска — тот же цвет, но окружность (дуги «a»); у маршрута — ломаная из «L»
      const paths = [...document.querySelectorAll('.leaflet-overlay-pane path')].filter(
        (el) => (el.getAttribute('stroke') || '').toLowerCase() === color,
      );
      return Math.max(0, ...paths.map((el) => (el.getAttribute('d').match(/L/g) || []).length));
    },
    routePath(color) {
      const paths = [...document.querySelectorAll('.leaflet-overlay-pane path')].filter(
        (el) => (el.getAttribute('stroke') || '').toLowerCase() === color && (el.getAttribute('d').match(/L/g) || []).length > 2,
      );
      return paths.sort((a, b) => b.getTotalLength() - a.getTotalLength())[0] ?? null;
    },
    /**
     * Голова зелёной линии в экранных пикселах и её длина. getScreenCTM переносит
     * пользовательские координаты SVG в координаты окна — иначе «M x y» сравнивать не с чем.
     * Меряем у своей машины заказа: «до ближайшей» прощает отставший хвост, если рядом
     * по парку едет свободная.
     */
    routeHead(color, plate) {
      const path = this.routePath(color);
      if (!path) return null;
      const m = path.getAttribute('d').match(/^M\\s*(-?[\\d.]+)[, ]+(-?[\\d.]+)/);
      if (!m) return null;
      const head = new DOMPoint(Number(m[1]), Number(m[2])).matrixTransform(path.getScreenCTM());
      const markers = plate
        ? [...document.querySelectorAll('.car-marker[title="' + plate + '"]')]
        : [...document.querySelectorAll('.car-marker')];
      let gap = Number.POSITIVE_INFINITY;
      for (const car of markers) {
        const r = car.getBoundingClientRect();
        gap = Math.min(gap, Math.hypot(head.x - (r.left + r.width / 2), head.y - (r.top + r.height / 2)));
      }
      return { gap: Math.round(gap), length: Math.round(path.getTotalLength()), markers: markers.length };
    },
    ridePlate() {
      return document.querySelector('.plate')?.textContent?.trim() ?? '';
    },
    // тайл, в котором лежит маркер посадки: y должен совпасть с эллипсоидальным
    // Меркатором (EPSG:3397), иначе данные и картинка карты расходятся на ~14 км
    tileUnderPin(startLat) {
      const pin = document.querySelector('.pin:not(.dest)');
      if (!pin) return null;
      const box = pin.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      for (const img of document.querySelectorAll('.leaflet-tile-loaded')) {
        // без \d — текст хелпера живёт в шаблонной строке, и бэкслэш в ней потерялся бы
        const m = img.src.match(/[?&]x=([0-9]+)&y=([0-9]+)&z=([0-9]+)/);
        if (!m) continue;
        const r = img.getBoundingClientRect();
        if (cx < r.left || cx >= r.right || cy < r.top || cy >= r.bottom) continue;
        const z = +m[3];
        const rad = (startLat * Math.PI) / 180;
        const e = 0.0818191908;
        const sin = Math.sin(rad);
        const psiEll = Math.log(Math.tan(Math.PI / 4 + rad / 2)) - (e * Math.log((1 + e * sin) / (1 - e * sin))) / 2;
        const row = (psi) => Math.floor((2 ** z) * (Math.PI - psi) / (2 * Math.PI));
        return {
          requested: +m[2],
          z,
          ellipsoidal: row(psiEll),
          spherical: row(Math.log(Math.tan(Math.PI / 4 + rad / 2))),
        };
      }
      return null;
    },
    /**
     * Треектория маркеров по кадрам экрана: сервер присылает снимок парка раз в POLL_MS,
     * а плавность — это то, что происходит между снимками. Возвращает для каждой наблюдаемой
     * машины число разных позиций за окно: 1–2 означает «прыжок раз в опрос», десятки —
     * что dead-reckoning на requestAnimationFrame действительно работает.
     */
    async carTrail(ms, tracks = 10) {
      const pick = () =>
        [...document.querySelectorAll('.car-marker')]
          .slice(0, tracks)
          .map((el) => {
            const r = el.getBoundingClientRect();
            return [Math.round(r.left * 20) / 20, Math.round(r.top * 20) / 20];
          });
      const frames = [];
      const started = performance.now();
      await new Promise((resolve) => {
        const tick = () => {
          frames.push(pick());
          if (performance.now() - started < ms) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      const perTrack = [];
      for (let index = 0; index < (frames[0]?.length ?? 0); index += 1) {
        const seen = new Set();
        let jumps = 0;
        let previous;
        for (const frame of frames) {
          const point = frame[index];
          if (!point) continue;
          seen.add(point.join(','));
          if (previous && (Math.abs(point[0] - previous[0]) > 0.5 || Math.abs(point[1] - previous[1]) > 0.5)) jumps += 1;
          previous = point;
        }
        perTrack.push({ unique: seen.size, jumps });
      }
      return { frames: frames.length, perTrack };
    },
    mapClick(xRatio, yRatio) {
      const map = document.querySelector('.leaflet-container');
      if (!map) return false;
      const rect = map.getBoundingClientRect();
      const x = rect.left + rect.width * xRatio;
      const y = rect.top + rect.height * yRatio;
      for (const type of ['mousedown', 'mouseup', 'click']) {
        map.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }));
      }
      return true;
    },
  };
  true;
`;

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT_DIR}/${name}.png`, Buffer.from(data, 'base64'));
  console.log(`    скриншот: docs/screenshots/${name}.png`);
}

const stamp = Date.now();
const email = `web${stamp}@dtramp.test`;
let fixtureToken;
let fixtureTrip;
async function fixtureRequest(query, variables = {}, token) {
  const response = await fetch(new URL('/graphql', APP_URL), { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10000) });
  const body = await response.json();
  if (body.errors?.length || !body.data) throw Error(body.errors?.[0]?.message ?? 'Нет ответа GraphQL');
  return body.data;
}


try {
  if (!(await waitFor(async () => fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.ok).catch(() => false), 10_000))) {
    throw new Error(`chrome-headless-shell не поднялся на :${DEBUG_PORT}. Путь: ${CHROME}`);
  }
  const session = await fixtureRequest('mutation ($input: RegisterInput!) { register(input: $input) { token } }', { input: { email: `ui-driver${stamp}@dtramp.test`, password: 'kursach123', name: 'Водитель UI-теста', role: 'DRIVER' } });
  fixtureToken = session.register.token;
  const seeded = await fixtureRequest('mutation ($input: CreateTripInput!) { createTrip(input: $input) { id } }', { input: { from: { name: 'Москва', lat: 55.7602, lon: 37.6087 }, to: { name: 'Тверь', lat: 56.8587, lon: 35.9176 }, dateTime: new Date(Date.now() + 3 * 86400000).toISOString(), seats: 3, price: 900 } }, fixtureToken);
  fixtureTrip = seeded.createTrip.id;
  mkdirSync(OUT_DIR, { recursive: true });
  await openPage(APP_URL);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  // профиль браузера переживает запуск: без сброса страница стартует залогиненной прошлым прогоном
  await evaluate(`localStorage.clear()`);
  await send('Page.navigate', { url: APP_URL });
  await sleep(2_000);
  await evaluate(helpers);

  console.log('\nUI-проверка D-Tramp');

  check('страница загрузилась', await waitFor(() => evaluate(`__ui.text().includes('Попутчик найдётся')`)), 'нет шапки');
  check('карта с тайлами Яндекса', await waitFor(() => evaluate(`document.querySelectorAll('.leaflet-tile-loaded').length > 4`)), 'тайлы не загрузились');
  check('водители на карте', await waitFor(() => evaluate(`document.querySelectorAll('.car-marker').length > 0`)), 'нет маркеров');
  // Плавность проверяем на приближенной карте: Leaflet ставит маркер целым числом пикселей,
  // а на z12 пиксель ≈ 38 м при скорости машины ≈ 11 м/с — промежуточные кадры просто
  // некуда рисовать. На z15 пиксель ≈ 5 м, и ведение между опросами становится видно.
  // Окно — 8 с и 30 машин: медленный свободный водитель (0.55 скорости) смещается на
  // 4–5 пикселей за окно, а «прыгает раз в опрос» — на 1. Порог вдвое больше числа опросов
  // за окно (8), так что запаса хватает и на медленных, и на припарковавшихся у цели.
  await evaluate(`(() => { for (let i = 0; i < 3; i += 1) document.querySelector('.leaflet-control-zoom-in')?.click(); return true; })()`);
  await sleep(2_500);
  const trail = await evaluate(`__ui.carTrail(8000, 30)`);
  await evaluate(`(() => { for (let i = 0; i < 3; i += 1) document.querySelector('.leaflet-control-zoom-out')?.click(); return true; })()`);
  const bestTrail = Math.max(0, ...(trail?.perTrack ?? []).map((track) => track.unique));
  check(
    'машины едут плавно между опросами, а не прыжками',
    !!trail && trail.frames > 60 && bestTrail >= 16,
    trail ? `кадров ${trail.frames}, машин ${trail.perTrack.length}, разных позиций у лучшей ${bestTrail} (нужно ≥16)` : 'маркеры не найдены',
  );
  await waitFor(() => evaluate(`!!__ui.tileUnderPin(${START_LAT})`));
  const tileFrame = await evaluate(`__ui.tileUnderPin(${START_LAT})`);
  check(
    'маркеры совпадают с тайлами Яндекса (эллипсоидальный Меркатор)',
    !!tileFrame && tileFrame.requested === tileFrame.ellipsoidal,
    tileFrame ? `y под маркером ${tileFrame.requested} при z=${tileFrame.z}; эллипсоидальный ${tileFrame.ellipsoidal}, сферический ${tileFrame.spherical}` : 'тайл под маркером не найден',
  );
  check('поиск попутки показывает результаты', await waitFor(() => evaluate(`__ui.text().includes('за место')`), 20_000), 'нет карточек поездок');
  await shot('01-guest-map-and-trips');

  console.log('\n— регистрация и вход');
  await evaluate(`document.querySelector('.login-button').click()`);
  await waitFor(() => evaluate(`document.querySelector('.auth-dialog').open`));
  await evaluate(`__ui.clickText('button', 'Регистрация')`);
  await evaluate(`__ui.fill('email', ${JSON.stringify(email)}) && __ui.fill('password', 'kursach123') && __ui.fill('name', 'Анна Тестова')`);
  await evaluate(`__ui.clickText('button', 'Создать аккаунт')`);
  check('аккаунт создан, пользователь в шапке', await waitFor(() => evaluate(`__ui.text().includes('Анна Тестова') && __ui.sessionEmail() === ${JSON.stringify(email)}`)), `в сессии не ${email}`);
  await shot('02-registered');

  console.log('\n— бронирование поездки');
  await evaluate(`__ui.fill('to', 'Тверь') && __ui.clickText('button', 'Найти')`);
  // ждём, пока пройдёт поиск: во время запроса кнопки брони временно выключены (state.busy)
  const booked = await waitFor(
    () => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((el) => el.innerText.includes('Забронировать') && !el.disabled); if (!b) return false; b.click(); return true; })()`),
    20_000,
  );
  check('кнопка брони активна', booked, 'все кнопки брони выключены');
  check('бронь подтверждена', await waitFor(() => evaluate(`__ui.text().includes('Забронировано')`), 10_000), 'уведомления нет');
  await shot('03-booked');

  console.log('\n— вызов машины');
  await evaluate(`__ui.clickText('button', 'Машина')`);
  // посадку тоже ставим кликом — раньше её можно было только тащить за пин из центра Москвы
  await evaluate(`__ui.pick('rideFrom')`);
  await evaluate(`__ui.mapClick(0.3, 0.62)`);
  const pickedFrom = await waitFor(() => evaluate(`!!__ui.pointField('rideFrom')`), 10_000);
  check(
    'точка посадки ставится кликом на карте',
    pickedFrom,
    `в поле «Откуда»: ${await evaluate(`__ui.fieldOf('rideFrom')`)}`,
  );
  await evaluate(`__ui.pick('rideDest')`);
  check('клик по карте выбирает точку', await waitFor(() => evaluate(`__ui.mapClick(0.72, 0.35)`), 10_000), 'карта не найдена в DOM');
  const pickedTo = await waitFor(() => evaluate(`!!__ui.pointField('rideDest')`), 10_000);
  check('точка назначения выбрана кликом по карте', pickedTo, `в поле «Куда»: ${await evaluate(`__ui.fieldOf('rideDest')`)}`);
  // прямая от точки до точки — это ровно 2 вершины; всё, что изгибается, уже лежит на улицах.
  // Порог «> 20» ловил не маршрут, а длину hops: на коротком заказе линий улицы дают 18.
  const previewDrawn = await waitFor(
    () => evaluate(`__ui.routeVertexCount('#8b98a8') > 2 && __ui.text().includes('по дорогам')`),
    20_000,
  );
  check(
    'предпросмотр до вызова машины идёт по улицам',
    previewDrawn,
    `вершин в серой линии: ${await evaluate(`__ui.routeVertexCount('#8b98a8')`)}, подпись километров: ${await evaluate(`(() => { const m = __ui.text().match(/[0-9.]+ км (по дорогам|по прямой)/); return m ? m[0] : 'нет подписи'; })()`)}`,
  );
  await shot('04-destination');
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((el) => el.innerText.includes('Вызвать машину')); if (!b || b.disabled) return false; b.click(); return true; })()`);
  check('машина вызвана', await waitFor(() => evaluate(`__ui.text().includes('Машина в пути')`), 10_000), 'карточки заказа нет');
  const routeDrawn = await waitFor(() => evaluate(`__ui.routeVertexCount('#3366ff') > 5`), 10_000);
  check('линия маршрута повторяет улицы', routeDrawn, `вершин в SVG-полилинии: ${await evaluate(`__ui.routeVertexCount('#3366ff')`)}`);
  await shot('05-ride-called');

  // съеденный маршрут: голова линии — там, где машина, и длина убывает, пока она едет
  const headOf = `__ui.routeHead('#3366ff', __ui.ridePlate())`;
  const headStart = (await waitFor(() => evaluate(`!!${headOf} && ${headOf}.markers === 1`), 10_000)) && (await evaluate(headOf));
  check(
    'зелёная линия маршрута начинается у машины',
    !!headStart && headStart.gap <= 8,
    headStart ? `до своей машины ${headStart.gap} px` : 'линия заказа не найдена',
  );
  await sleep(25_000);
  const headLater = await evaluate(headOf);
  check(
    'маршрут укорачивается вслед за машиной',
    !!headStart && !!headLater && headLater.length <= headStart.length - 3,
    `длина была ${headStart?.length} px, стала ${headLater?.length} px`,
  );
  // главная засада: индекс съеденного уезжает вперёд за машину — начало линии отрывается
  // от маркера и тянется прямой через кварталы. Через 25 с голова всё ещё у бампера.
  check(
    'голова линии не отстаёт от машины со временем',
    !!headLater && headLater.gap <= 14,
    headLater ? `через 25 с: ${headLater.gap} px` : 'линия пропала',
  );

  console.log('\n— вкладка «Мои»');
  await evaluate(`__ui.clickText('button', 'Мои')`);
  check('бронь видна в «Мои»', await waitFor(() => evaluate(`__ui.text().includes('Мои брони') && !__ui.text().includes('Пока пусто')`)), 'список пуст');
  await shot('06-mine');
} catch (error) {
  failed += 1;
  console.error('\nОшибка прогона:', error instanceof Error ? error.message : error);
} finally {
  if (fixtureTrip) {
    try { await fixtureRequest('mutation ($id: ID!) { cancelTrip(id: $id) { id } }', { id: fixtureTrip }, fixtureToken); }
    catch (error) { failed += 1; console.error('Не удалось снять поездку UI-теста:', error.message); }
  }
  chrome.kill('SIGTERM');
  if (pageErrors.length) {
    console.log('\nОшибки страницы:');
    for (const error of [...new Set(pageErrors)].slice(0, 5)) console.log('  - ' + error.split('\n')[0]);
  }
  console.log(`\nИтог: ${passed} ok, ${failed} fail`);
  process.exit(failed === 0 ? 0 : 1);
}

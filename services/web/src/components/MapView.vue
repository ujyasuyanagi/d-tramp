<script setup lang="ts">
import L from 'leaflet';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ui } from '../ui';
import type { Ride } from '../api';
import { actions, driversInRadius, state } from '../store';

/**
 * Тайлы Яндекс.Карт без API-ключа и без OpenStreetMap: свой слой ходит на
 * core-renderer-tiles (~80 мс на тайл), при серии ошибок показываем баннер,
 * но маркеры и вся логика продолжают работать — карта не «вешает» приложение.
 */
const YANDEX_TILES = 'https://core-renderer-tiles.maps.yandex.net/tiles?l=map&x={x}&y={y}&z={z}&scale=1';
const POLL_MS = 1_000;

/**
 * Слой пробок — прозрачный PNG из Static API Яндекса. Ключ для бесплатной версии не нужен,
 * но сервис периодически отвечает пустой картинкой (лимит), поэтому снимок кэшируем и
 * обновляем редко: пробки на карте не обязаны жить с частотой парка машин.
 */
const TRAFFIC_WIDTH = 650;
const TRAFFIC_HEIGHT = 450;
const TRAFFIC_REFRESH_MS = 90_000;
const TRAFFIC_DEBOUNCE_MS = 600;
/** Пустой ответ Static API — PNG с одним логотипом, ~6 КБ; полный слой заметно тяжелее. */
const TRAFFIC_EMPTY_BYTES = 15_000;

/**
 * Сервер присылает снимок парка раз в POLL_MS, а экран живёт каждый кадр: между
 * последним показанным положением и новой позицией из ответа маркер ведётся линейно.
 * Без этого парк едет «прыжками» — раз в два тика симуляции по несколько десятков метров.
 */
interface CarMotion {
  from: L.LatLng;
  to: L.LatLng;
  startedAt: number;
}

/** Прыжок больше этого — не движение машины, а смена цели или респаун: ставим сразу. */
const TELEPORT_KM = 1.5;

/**
 * Потолок круга обзора: парк стоит по городам ЦФО, и на уровне «вся Россия» просить
 * все машины бессмысленно — показываем то, что ближе к центру экрана.
 */
const MAX_VIEW_KM = 150;

const container = ref<HTMLDivElement | null>(null);
const tileProblem = ref(false);
const trafficOn = ref(true);
const trafficProblem = ref(false);
const cursorPick = computed(() => state.pickTarget !== 'none');

let map: L.Map | undefined;
let radius: L.Circle | undefined;
let pickupMarker: L.Marker | undefined;
let destMarker: L.Marker | undefined;
let routeLine: L.Polyline | undefined;
let fittedRide: string | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let animationFrame: number | undefined;
const cars = new Map<string, L.Marker>();
const motion = new Map<string, CarMotion>();
let trafficOverlay: L.ImageOverlay | undefined;
let trafficObjectUrl: string | undefined;
let trafficTimer: ReturnType<typeof setInterval> | undefined;
let trafficDebounce: ReturnType<typeof setTimeout> | undefined;
let trafficBusy = false;
let trafficDirty = false;
let trafficGeneration = 0;

/**
 * Вершина маршрута, до которой водитель уже проехал. Индекс только растёт: координаты
 * из опроса дрожат, и без этого ограничение назад зелёная линия то отрастала бы, то съедалась.
 */
let consumedIndex = 0;
let consumedRide: string | undefined;

/**
 * Остаток маршрута заказа: линия начинается от текущей позиции машины, а съеденный
 * кусок streets позади не рисуется — иначе «маршрут» показывает, где машина уже была.
 * Позиция водителя приходит из того же опроса парка; без неё линия остаётся полной.
 */
function remainingAlong(ride: Ride, along: L.LatLng[]): L.LatLng[] {
  if (along.length < 2) return along;
  if (consumedRide !== ride.id) {
    consumedRide = ride.id;
    consumedIndex = 0;
  }
  const driver = state.drivers.find((candidate) => candidate.id === ride.driverId);
  // водителя нет в опросе (ушёл за круг обзора) — съеденный кусок всё равно не возвращаем
  if (!driver) return along.slice(consumedIndex);

  const here = L.latLng(driver.lat, driver.lon);
  // метрика в градусах с лонготу сжатом по широте — только чтобы выбрать ближайший сегмент
  const squeeze = Math.cos((here.lat * Math.PI) / 180);
  const flat = (point: L.LatLng) => ({ x: point.lng * squeeze, y: point.lat });
  const target = flat(here);
  let bestIndex = consumedIndex;
  let bestRatio = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = consumedIndex; index < along.length - 1; index += 1) {
    const a = flat(along[index]!);
    const b = flat(along[index + 1]!);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const span = dx * dx + dy * dy;
    const ratio = span ? Math.min(1, Math.max(0, ((target.x - a.x) * dx + (target.y - a.y) * dy) / span)) : 0;
    const distance = Math.hypot(target.x - (a.x + dx * ratio), target.y - (a.y + dy * ratio));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
      bestRatio = ratio;
    }
  }
  // ratio === 0 — ближайшая вершина ещё впереди машины, съедать её нельзя: иначе на каждом
  // опросе индекс уходит на вершину вперёд, машина отстаёт, и начало линии тянется прямой
  // через весь район.
  consumedIndex = bestRatio === 0 ? bestIndex : Math.min(bestIndex + 1, along.length - 1);
  return [here, ...along.slice(consumedIndex)];
}

const pinIcon = (kind: 'pickup' | 'dest') =>
  L.divIcon({
    className: '',
    html: `<div class="pin${kind === 'dest' ? ' dest' : ''}"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });

function carIcon(plate: string, free: boolean, far: boolean, selected = false) {
  return L.divIcon({
    className: '',
    html: `<div class="car-marker${free ? '' : ' busy'}${far ? ' far' : ''}${selected ? ' selected' : ''}" title="${plate}">&#x25CF;</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

/** За кругом поиска машина остаётся на карте, но приглушена — это парк, а не вариант для заказа. */
const isFar = (driver: (typeof state.drivers)[number]) => (driver.distanceKm ?? 0) > state.radiusKm;

function plateTooltip(driver: (typeof state.drivers)[number]) {
  return `<strong>${driver.car.plate}</strong>`;
}

function renderCars() {
  const seen = new Set<string>();
  for (const driver of state.drivers) {
    if (ui.selectedDriver?.id === driver.id) ui.selectedDriver = driver;
    seen.add(driver.id);
    const position = L.latLng(driver.lat, driver.lon);
    const existing = cars.get(driver.id);
    if (existing) {
      // Отправная точка — та, что сейчас на экране (возможно, середина прошлого скольжения),
      // иначе при опережающем ответе маркер отпрыгнет назад.
      const shown = existing.getLatLng();
      if (map!.distance(shown, position) / 1000 > TELEPORT_KM) existing.setLatLng(position);
      else motion.set(driver.id, { from: shown, to: position, startedAt: performance.now() });
      existing.setIcon(carIcon(driver.car.plate, driver.status === 'FREE', isFar(driver), ui.selectedDriver?.id === driver.id));
      existing.setTooltipContent(plateTooltip(driver));
    } else {
      const marker = L.marker(position, {
        icon: carIcon(driver.car.plate, driver.status === 'FREE', isFar(driver), ui.selectedDriver?.id === driver.id),
        title: `${driver.car.model} · ${driver.car.plate} — информация о водителе`,
        alt: `${driver.car.model} · ${driver.car.plate}`,
        bubblingMouseEvents: false,
      })
        .on('click', () => {
          const current = state.drivers.find((candidate) => candidate.id === driver.id);
          if (current && state.pickTarget === 'none') ui.selectedDriver = current;
        })
        .bindTooltip(plateTooltip(driver), { direction: 'top', offset: [0, -10] })
        .addTo(map!);
      cars.set(driver.id, marker);
    }
  }
  for (const [id, marker] of cars) {
    if (!seen.has(id)) {
      marker.remove();
      cars.delete(id);
      motion.delete(id);
    }
  }
}

/** Каждый кадр — новая доля пути от прошлого снимка к текущему. Доехал — ждёт следующий опрос. */
function animate() {
  const now = performance.now();
  for (const [id, car] of motion) {
    const marker = cars.get(id);
    if (!marker) {
      motion.delete(id);
      continue;
    }
    const progress = (now - car.startedAt) / POLL_MS;
    if (progress >= 1) {
      motion.delete(id);
      continue;
    }
    marker.setLatLng(L.latLng(
      car.from.lat + (car.to.lat - car.from.lat) * progress,
      car.from.lng + (car.to.lng - car.from.lng) * progress,
    ));
  }
  animationFrame = requestAnimationFrame(animate);
}

// Keep routes and pickup points in the portion of the map not covered by the panel.
function mapPadding(): { paddingTopLeft: L.Point; paddingBottomRight: L.Point } {
  const panel = document.querySelector('.panel')?.getBoundingClientRect();
  const bounds = container.value?.getBoundingClientRect();
  const mobile = matchMedia('(max-width: 760px)').matches;
  const overlap = panel && bounds ? (mobile ? bounds.bottom - panel.top : panel.right - bounds.left) : 0;
  return {
    paddingTopLeft: L.point(mobile ? 24 : overlap + 24, 32),
    paddingBottomRight: L.point(64, mobile ? overlap + 24 : 32),
  };
}
function centerPickup(zoom?: number) {
  if (!map) return;
  const point = L.latLng(state.pickup.lat, state.pickup.lon);
  map.setView(point, zoom ?? map.getZoom(), { animate: false });
  const padding = mapPadding();
  map.panBy(padding.paddingBottomRight.subtract(padding.paddingTopLeft).divideBy(2), { animate: false });
}

let stopResizeObserver: (() => void) | undefined;

function syncOverlays() {
  if (!map) return;
  const pickup = L.latLng(state.pickup.lat, state.pickup.lon);

  radius ??= L.circle(pickup, { radius: state.radiusKm * 1000, color: '#3366ff', weight: 1, fillOpacity: 0.05, dashArray: '4 4' }).addTo(map);
  radius.setLatLng(pickup).setRadius(state.radiusKm * 1000);

  pickupMarker ??= L.marker(pickup, { icon: pinIcon('pickup'), draggable: true, zIndexOffset: 400 })
    .addTo(map)
    .bindTooltip('Точка посадки — перетащи или выбери кликом: «Откуда» → «На карте»', { direction: 'top', offset: [0, -10] });
  // обработчик вешается один раз при создании: syncOverlays вызывается на каждом опросе парка
  pickupMarker.on('dragend', () => {
    const point = pickupMarker!.getLatLng();
    actions.setPickup({ lat: point.lat, lon: point.lng, name: state.pickup.name });
  });
  pickupMarker.setLatLng(pickup);

  if (state.destination) {
    const dest = L.latLng(state.destination.lat, state.destination.lon);
    destMarker ??= L.marker(dest, { icon: pinIcon('dest'), draggable: true, zIndexOffset: 400 }).addTo(map);
    destMarker.on('dragend', () => {
      const point = destMarker!.getLatLng();
      actions.pickFromMap({ lat: point.lat, lon: point.lng, name: state.destination?.name });
    });
    destMarker.setLatLng(dest);

    routeLine ??= L.polyline([pickup, dest], { color: '#8b98a8', weight: 3, dashArray: '6 6', opacity: 0.8 }).addTo(map);
    // У заказа есть геометрия от роутера; до заказа рисуем предпросмотр той же дороги,
    // а если дорог под точками нет — честная прямая связка двух точек.
    const full = (state.activeRide?.path?.length ? state.activeRide.path : (state.preview?.path ?? [state.pickup, state.destination])).map(
      (point) => L.latLng(point.lat, point.lon),
    );
    // у активного заказа позади машины остаётся только что проеханный кусок улиц — его не показываем
    const along = state.activeRide ? remainingAlong(state.activeRide, full) : full;
    routeLine.setLatLngs(along);
    // маршрут заказа — сплошная линия: пунктир можно спутать с окружностью радиуса поиска
    routeLine.setStyle(
      state.activeRide
        ? { color: '#3366ff', weight: 4, dashArray: '' }
        : { color: '#8b98a8', weight: 3, dashArray: '6 6' },
    );
    // один раз на заказ показываем весь маршрут целиком — дальше картой правит пользователь
    if (state.activeRide?.path?.length && fittedRide !== state.activeRide.id) {
      fittedRide = state.activeRide.id;
      map.fitBounds(L.latLngBounds(full).pad(0.2), mapPadding());
    } else if (!state.activeRide) {
      fittedRide = undefined;
    }
  } else {
    destMarker?.remove();
    destMarker = undefined;
    routeLine?.remove();
    routeLine = undefined;
  }
}

/**
 * Круг обзора — половина диагонали видимой области: он накрывает все четыре угла экрана.
 * Сервер по нему отдаёт только те машины, что могут оказаться на глазах у пользователя.
 */
function syncView() {
  if (!map) return;
  const bounds = map.getBounds();
  const center = bounds.getCenter();
  const diagonalKm = bounds.getSouthWest().distanceTo(bounds.getNorthEast()) / 1000;
  actions.setView({ lat: center.lat, lon: center.lng, radiusKm: Math.round(Math.min(MAX_VIEW_KM, diagonalKm / 2)) });
}

/**
 * Static API отдаёт максимум 650×450, поэтому на большом экране просим zoom на один меньше:
 * картинка растянется, зато полосы пробок будут по всему видимому полотну, а не только в центре.
 */
function trafficZoom(): number {
  if (!map) return 12;
  const size = map.getSize();
  const drop = Math.max(size.x / TRAFFIC_WIDTH, size.y / TRAFFIC_HEIGHT) > 1 ? 1 : 0;
  return Math.max(1, Math.min(19, Math.round(map.getZoom()) - drop));
}

/**
 * Снимок Static API считается в сферическом Меркаторе. Дальше Leaflet сам перепроецирует
 * углы в EPSG:3395: на городских зумах расхождение меньше пикселя.
 */
function trafficBounds(center: L.LatLng, zoom: number): L.LatLngBounds {
  const middle = L.CRS.EPSG3857.latLngToPoint(center, zoom);
  const half = L.point(TRAFFIC_WIDTH / 2, TRAFFIC_HEIGHT / 2);
  return L.latLngBounds(
    L.CRS.EPSG3857.pointToLatLng(middle.subtract(half), zoom),
    L.CRS.EPSG3857.pointToLatLng(middle.add(half), zoom),
  );
}

function trafficUrl(center: L.LatLng, zoom: number): string {
  return `https://static-maps.yandex.ru/1.x/?lang=ru_RU&l=trf&ll=${center.lng.toFixed(6)},${center.lat.toFixed(6)}&z=${zoom}&size=${TRAFFIC_WIDTH},${TRAFFIC_HEIGHT}`;
}

async function refreshTraffic() {
  if (!map || !trafficOn.value) return;
  if (trafficBusy) {
    trafficDirty = true;
    return;
  }
  trafficBusy = true;
  const generation = ++trafficGeneration;
  let objectUrl: string | undefined;
  try {
    const mapRef = map;
    const zoom = trafficZoom();
    const center = mapRef.getCenter();
    const response = await fetch(trafficUrl(center, zoom), { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    // Пустой ответ Яндекса — PNG с одним логотипом ~6 КБ. Не затираем прошлый снимок.
    if (!blob.type.startsWith('image/') || blob.size < TRAFFIC_EMPTY_BYTES) throw new Error('пустой слой');
    if (generation !== trafficGeneration) return;

    objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    if (generation !== trafficGeneration || !map) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = undefined;
      return;
    }

    const overlay = L.imageOverlay(objectUrl, trafficBounds(center, zoom), {
      pane: 'trafficPane',
      opacity: 0.95,
      interactive: false,
    }).addTo(map);
    trafficOverlay?.remove();
    if (trafficObjectUrl) URL.revokeObjectURL(trafficObjectUrl);
    trafficOverlay = overlay;
    trafficObjectUrl = objectUrl;
    objectUrl = undefined;
    trafficProblem.value = false;
  } catch {
    // Устаревшие полосы полезнее пустой карты: прошлый снимок не убираем.
    if (generation === trafficGeneration) trafficProblem.value = true;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    trafficBusy = false;
    if (trafficDirty) {
      trafficDirty = false;
      void refreshTraffic();
    }
  }
}

function stopTrafficTimer() {
  if (trafficTimer) {
    clearInterval(trafficTimer);
    trafficTimer = undefined;
  }
  if (trafficDebounce) {
    clearTimeout(trafficDebounce);
    trafficDebounce = undefined;
  }
}

function scheduleTrafficRefresh() {
  if (!trafficOn.value) return;
  if (trafficDebounce) clearTimeout(trafficDebounce);
  trafficDebounce = setTimeout(() => {
    trafficDebounce = undefined;
    void refreshTraffic();
  }, TRAFFIC_DEBOUNCE_MS);
}

function startTraffic() {
  stopTrafficTimer();
  trafficTimer = setInterval(() => void refreshTraffic(), TRAFFIC_REFRESH_MS);
  scheduleTrafficRefresh();
}

function stopTraffic() {
  trafficGeneration += 1;
  stopTrafficTimer();
  trafficOverlay?.remove();
  trafficOverlay = undefined;
  if (trafficObjectUrl) {
    URL.revokeObjectURL(trafficObjectUrl);
    trafficObjectUrl = undefined;
  }
  trafficProblem.value = false;
}

function toggleTraffic() {
  trafficOn.value = !trafficOn.value;
  if (trafficOn.value) startTraffic();
  else stopTraffic();
}

onMounted(() => {
  map = L.map(container.value!, {
    // Яндекс рисует тайлы в эллипсоидальном Меркаторе (EPSG:3397 ≈ 3395), а Leaflet
    // по умолчанию — в сферическом (3857). Над Москвой это расхождение ~14 км:
    // маркеры «уезжают» с дорог на подмосковные поля. 3395 совмещает тайлы и данные.
    crs: L.CRS.EPSG3395,
    zoomControl: false,
    attributionControl: true,
  }).setView([state.pickup.lat, state.pickup.lon], 12);

  // Оставляем только подпись источника тайлов.
  map.attributionControl.setPrefix(false);

  L.control.zoom({ position: 'topright' }).addTo(map);

  // Отдельная панель между тайлами (200) и маршрутами/маркерами (400+),
  // чтобы цветные полосы не перекрывали линию поездки и машины.
  map.createPane('trafficPane');
  const trafficPane = map.getPane('trafficPane');
  if (trafficPane) {
    trafficPane.style.zIndex = '350';
    trafficPane.style.pointerEvents = 'none';
  }

  const layer = L.tileLayer(YANDEX_TILES, {
    maxZoom: 19,
    attribution: '© Яндекс.Карты',
    // не ждём бесконечно: висящий тайл не должен блокировать слой
    updateWhenIdle: false,
    keepBuffer: 1,
  }).addTo(map);

  let failures = 0;
  layer.on('tileerror', () => {
    failures += 1;
    if (failures >= 5) tileProblem.value = true;
  });
  layer.on('tileload', () => {
    failures = Math.max(0, failures - 1);
    if (failures < 2) tileProblem.value = false;
  });

  map.on('click', (event: L.LeafletMouseEvent) => {
    if (state.pickTarget === 'none') return;
    actions.pickFromMap({ lat: event.latlng.lat, lon: event.latlng.lng });
  });

  // Контейнер получает финальные размеры после разметки grid: без этого центр карты уезжает.
  const observer = new ResizeObserver(() => {
    map?.invalidateSize();
    syncView();
    scheduleTrafficRefresh();
  });
  observer.observe(container.value!);
  stopResizeObserver = () => observer.disconnect();
  requestAnimationFrame(() => {
    map?.invalidateSize();
    centerPickup();
    if (trafficOn.value) startTraffic();
  });

  // moveend ловит и панорамирование, и зум, и fitBounds после вызова машины
  map.on('moveend', syncView);
  map.on('moveend', scheduleTrafficRefresh);
  syncView();

  syncOverlays();
  renderCars();
  void actions.refreshDrivers();
  pollTimer = setInterval(() => void actions.refreshDrivers(), POLL_MS);
  animationFrame = requestAnimationFrame(animate);
});

onBeforeUnmount(() => {
  stopResizeObserver?.();
  stopTraffic();
  if (pollTimer) clearInterval(pollTimer);
  if (animationFrame) cancelAnimationFrame(animationFrame);
  actions.setView(null);
  map?.remove();
  map = undefined;
  cars.clear();
  motion.clear();
});

watch(() => state.drivers, renderCars, { deep: true });
watch(() => ui.selectedDriver?.id, () => {
  for (const driver of state.drivers) {
    cars.get(driver.id)?.setIcon(carIcon(driver.car.plate, driver.status === 'FREE', isFar(driver), ui.selectedDriver?.id === driver.id));
  }
});
// линия заказа идёт за машиной: перезапускаем разметку, только когда водитель реально сместился
watch(
  () => {
    const ride = state.activeRide;
    if (!ride) return null;
    const driver = state.drivers.find((candidate) => candidate.id === ride.driverId);
    return driver ? `${driver.lat.toFixed(6)},${driver.lon.toFixed(6)}` : null;
  },
  () => syncOverlays(),
);
watch(
  () => [state.pickup.lat, state.pickup.lon, state.radiusKm, state.destination?.lat, state.destination?.lon, state.activeRide?.status],
  () => {
    void actions.refreshPreview();
    syncOverlays();
  },
);
// предпросмотр приходит асинхронно: без этого линия останется прямой до следующего движения пина
watch(() => state.preview, syncOverlays);
watch(
  () => [state.pickup.lat, state.pickup.lon] as [number, number],
  () => { centerPickup(); },
  { flush: 'post' },
);
// «Где я»: панорамирования выше недостаточно — с z6 перелёт в свой район выглядит как ничего
// не произошло, поэтому по этому требованию ещё и приближаем.
watch(
  () => state.recenterToken,
  () => {
    if (map) centerPickup(Math.max(map.getZoom(), 13));
  },
);
</script>

<template>
  <div class="map-wrap" :class="{ picking: cursorPick }">
    <div ref="container" class="map" />
    <button
      type="button"
      class="traffic-button icon-button map-hint"
      :class="{ active: trafficOn }"
      :aria-pressed="trafficOn"
      :aria-label="trafficOn ? 'Скрыть слой пробок' : 'Показать слой пробок'"
      :data-hint="trafficOn ? 'Скрыть слой пробок' : 'Показать слой пробок'"
      @click="toggleTraffic"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M7 7a5 5 0 0 1 5 -5a5 5 0 0 1 5 5v10a5 5 0 0 1 -5 5a5 5 0 0 1 -5 -5l0 -10" />
        <path d="M11 7a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
        <path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
        <path d="M11 17a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
      </svg>
    </button>
    <div class="map-overlay">
      <div v-if="trafficOn && trafficProblem" class="map-note map-warning">
        Пробки не обновились — Яндекс временно не отдаёт слой.
      </div>
      <div v-if="tileProblem" class="map-note map-warning">
        Тайлы Яндекс.Карт не отдаются — карта схематичная, водители и заказы работают как обычно.
      </div>
      <div v-if="state.driversError" class="map-note map-warning">
        {{ state.driversError }}
      </div>
      <div class="map-note">
        {{ driversInRadius.filter((driver) => driver.status === 'FREE').length }} свободных ·
        {{ driversInRadius.length }} машин в {{ state.radiusKm }} км
        <template v-if="state.drivers.length > driversInRadius.length">
          и ещё {{ state.drivers.length - driversInRadius.length }} в поле зрения
        </template>

      </div>
    </div>
  </div>
</template>

<style scoped>
.map-wrap.picking .map {
  cursor: crosshair;
}

.traffic-button {
  position: absolute;
  top: 172px;
  right: 24px;
  z-index: 600;
  color: var(--muted);
  background: var(--surface);
  box-shadow: var(--shadow);
  border-radius: 14px;
}

.traffic-button.active {
  color: var(--text);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.traffic-button svg {
  width: 22px;
  height: 22px;
}

@media (max-width: 760px) {
  .traffic-button {
    top: 164px;
    right: 16px;
  }
}
</style>

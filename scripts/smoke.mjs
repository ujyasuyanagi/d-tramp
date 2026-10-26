#!/usr/bin/env node
/**
 * Смоук-тест D-Tramp через GraphQL-шлюз: auth → поездка → бронь → карта → вызов машины.
 * Требует запущенных сервисов (docker compose up или npm run dev).
 */
const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:4000/graphql';
const stamp = Date.now();

let passed = 0;
let failed = 0;

const OSRM = process.env.OSRM_PUBLIC_URL ?? 'http://localhost:5002';

/** Расстояние по большой окружности, км — своя копия, чтобы смоук не зависел от сборки shared. */
function haversineKm(a, b) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Расстояние от точки до ближайшей дороги в graph OSRM, метры; null, если OSRM недоступен. */
async function nearestRoadMeters(lat, lon) {
  try {
    const response = await fetch(`${OSRM}/nearest/v1/driving/${lon},${lat}?number=1`, {
      signal: AbortSignal.timeout(3000),
    });
    const body = await response.json();
    if (body.code !== 'Ok') return null;
    return body.waypoints?.[0]?.distance ?? null;
  } catch {
    return null;
  }
}

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` → ${JSON.stringify(detail)}` : ''}`);
  }
}

async function gql(query, variables = {}, token) {
  const response = await fetch(GATEWAY, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (body.errors) {
    return { errors: body.errors, data: body.data };
  }
  return { data: body.data };
}

const fail = (result) => result.errors?.[0]?.message ?? '(без ошибки)';
const ok = (result) => result.data ?? null;
const must = (value, what) => {
  if (value === undefined || value === null) {
    console.error(`Обрыв смоук-теста: ${what} не получен`);
    throw new Error(`Смоук-тест прерван: ${what}`);
  }
  return value;
};

const USER_FIELDS = 'id email name role rating tripsCount';
const TRIP_FIELDS = `id dateTime seatsTotal seatsAvailable price distanceKm status comment
  from { name lat lon } to { name lat lon } driver { id name role }`;

/** Линия между точками — тем же запросом, которым её просит фронт. */
async function roadRoute(from, to) {
  const result = await gql(
    `query ($from: GeoPointInput!, $to: GeoPointInput!) {
       roadRoute(from: $from, to: $to) { byRoad distanceKm durationMin path { lat lon } }
     }`,
    { from, to },
  );
  return ok(result)?.roadRoute ?? null;
}

// Always unpublish trips created by the test, including on an interrupted assertion.
const createdTrips = [];
try {
// ─── 1. Аутентификация ──────────────────────────────────────────────────────
console.log('\n1. user-service: регистрация и вход');

const driver = must(ok(await gql(`mutation { register(input: {email: "driver${stamp}@dtramp.test", password: "kursach123", name: "Тестовый водитель", role: DRIVER, phone: "+79001112233"}) { token user { ${USER_FIELDS} } } }`))?.register, 'register(driver)');
check('регистрация водителя вернула токен', Boolean(driver.token), driver);
check('роль DRIVER', driver.user?.role === 'DRIVER', driver.user);

const reRegister = await gql(`mutation { register(input: {email: "driver${stamp}@dtramp.test", password: "kursach123", name: "Дубль", role: DRIVER}) { token } }`);
check('повторная регистрация отклонена', fail(reRegister)?.includes('уже зарегистрирован'), fail(reRegister));

const badLogin = await gql(`mutation { login(input: {email: "driver${stamp}@dtramp.test", password: "wrong"}) { token } }`);
check('вход с неверным паролем отклонён', Boolean(badLogin.errors), fail(badLogin));

const passenger = must(ok(await gql(`mutation { register(input: {email: "pass${stamp}@dtramp.test", password: "kursach123", name: "Пётр Пассажиров", role: PASSENGER}) { token user { ${USER_FIELDS} } } }`))?.register, 'register(passenger)');
check('регистрация пассажира', Boolean(passenger.token), passenger);

const login = ok(await gql(`mutation { login(input: {email: "pass${stamp}@dtramp.test", password: "kursach123"}) { token user { ${USER_FIELDS} } } }`))?.login;
check('вход пассажира', login?.user?.email === `pass${stamp}@dtramp.test`, login);

const me = ok(await gql(`query { me { ${USER_FIELDS} } }`, {}, passenger.token))?.me;
check('me по токену', me?.id === passenger.user?.id, me);

const anonymous = await gql('query { me { id } }');
check('me без токена отклонён', fail(anonymous)?.includes('авторизац'), fail(anonymous));

const updated = ok(await gql(`mutation { updateProfile(input: {name: "Пётр Обновлён", phone: "+79000000000"}) { ${USER_FIELDS} } }`, {}, passenger.token))?.updateProfile;
check('обновление профиля', updated?.name === 'Пётр Обновлён', updated);

// ─── 2. Поездки и брони ─────────────────────────────────────────────────────
console.log('\n2. trip-service: поездки и брони');

const tripDate = new Date(Date.now() + 3 * 86_400_000).toISOString();
const trip = must(ok(await gql(`mutation ($input: CreateTripInput!) { createTrip(input: $input) { ${TRIP_FIELDS} } }`, {
  input: {
    from: { name: 'Москва, Тверская', lat: 55.7602, lon: 37.6087 },
    to: { name: 'Тверь', lat: 56.8587, lon: 35.9176 },
    dateTime: tripDate,
    seats: 3,
    price: 900,
    comment: 'Еду утром, багаж в салоне',
  },
}, driver.token))?.createTrip, 'createTrip');
createdTrips.push({ id: trip.id, token: driver.token });
check('создание поездки', trip.id !== undefined, trip);
check('мест доступно = всего', trip.seatsAvailable === 3 && trip.seatsTotal === 3, trip);
check('расстояние посчитано', (trip.distanceKm ?? 0) > 150, trip.distanceKm);

const tripStraight = haversineKm({ lat: 55.7602, lon: 37.6087 }, { lat: 56.8587, lon: 35.9176 });
const tripRoad = await roadRoute({ lat: 55.7602, lon: 37.6087 }, { lat: 56.8587, lon: 35.9176 });
check(
  'километры поездки берутся с дорог',
  tripRoad?.byRoad ? trip.distanceKm > tripStraight * 1.02 : trip.distanceKm > tripStraight * 0.98,
  `у поездки ${trip.distanceKm} км, прямая ${tripStraight.toFixed(1)} км; роутер: ${tripRoad?.byRoad ? `дороги, ${tripRoad.distanceKm} км` : 'под точками дорог в графе нет'}`,
);
console.log(`    Москва → Тверь: ${trip.distanceKm} км, по прямой ${tripStraight.toFixed(1)} км, дорожный ответ: ${tripRoad?.byRoad ? `${tripRoad.distanceKm} км / ${tripRoad.durationMin} мин` : 'прямая'}`);
check('driver резолвится через user-service', trip.driver?.name === 'Тестовый водитель', trip.driver);

const past = await gql('mutation ($input: CreateTripInput!) { createTrip(input: $input) { id } }', {
  input: { from: { lat: 55.76, lon: 37.61 }, to: { lat: 56.85, lon: 35.91 }, dateTime: new Date(Date.now() - 86_400_000).toISOString(), seats: 1, price: 100 },
}, driver.token);
check('поездка в прошлом отклонена', Boolean(past.errors), fail(past));

const found = ok(await gql('query ($to: String) { trips(to: $to, limit: 10) { id seatsAvailable driver { name } } }', { to: 'Тверь' }));
check('публичный поиск без токена', (found?.trips.length ?? 0) >= 1, found);

const booking = must(ok(await gql('mutation ($tripId: ID!) { bookTrip(tripId: $tripId, seats: 2) { id seats priceTotal status trip { id } passenger { name } } }', { tripId: trip.id }, passenger.token))?.bookTrip, 'bookTrip');
check('бронь 2 мест', booking.seats === 2 && booking.priceTotal === 1800, booking);
check('бронь знает пассажира и поездку', booking.passenger?.name === 'Пётр Обновлён' && booking.trip?.id === trip.id, booking);

const afterBooking = ok(await gql(`query ($id: ID!) { trip(id: $id) { seatsAvailable } }`, { id: trip.id }));
check('мест стало меньше (1 из 3)', afterBooking?.trip?.seatsAvailable === 1, afterBooking?.trip);

const duplicate = await gql('mutation ($tripId: ID!) { bookTrip(tripId: $tripId, seats: 1) { id } }', { tripId: trip.id }, passenger.token);
check('повторная бронь отклонена', Boolean(duplicate.errors), fail(duplicate));

const third = ok(await gql(`mutation { register(input: {email: "third${stamp}@dtramp.test", password: "kursach123", name: "Третий", role: PASSENGER}) { token } }`))?.register;
const overflow = await gql('mutation ($tripId: ID!) { bookTrip(tripId: $tripId, seats: 2) { id } }', { tripId: trip.id }, third.token);
check('недостаточно мест → ошибка сервиса дошла до клиента', (fail(overflow) ?? '').includes('Недостаточно'), fail(overflow));

const myBookings = ok(await gql('query { bookings { id status seats } }', {}, passenger.token));
check('список броней пассажира', (myBookings?.bookings.length ?? 0) === 1, myBookings);

const foreignBookings = await gql('query ($tripId: ID!) { bookings(tripId: $tripId) { id } }', { tripId: trip.id }, third.token);
check('чужие брони поездки скрыты', foreignBookings.errors?.[0]?.extensions?.code === 'FORBIDDEN', fail(foreignBookings));
const ownerBookings = ok(await gql('query ($tripId: ID!) { bookings(tripId: $tripId) { id passenger { name } } }', { tripId: trip.id }, driver.token));
check('водитель видит брони своей поездки', (ownerBookings?.bookings.length ?? 0) === 1, ownerBookings);

const cancelled = ok(await gql('mutation ($id: ID!) { cancelBooking(id: $id) { id status } }', { id: booking.id }, passenger.token));
check('отмена брони', cancelled?.cancelBooking?.status === 'CANCELLED', cancelled);
const seatsBack = ok(await gql(`query ($id: ID!) { trip(id: $id) { seatsAvailable } }`, { id: trip.id }));
check('места вернулись после отмены', seatsBack?.trip?.seatsAvailable === 3, seatsBack?.trip);

// ─── 3. Карта: виртуальные водители ─────────────────────────────────────────
console.log('\n3. map-service: водители, номера, вызов машины');

const near = ok(await gql('query { driversNear(lat: 55.7558, lon: 37.6173, radiusKm: 3) { radiusKm drivers { id lat lon name status freeRide pricePerKm distanceKm car { model plate regionLabel } } } }'));
const drivers = near?.driversNear?.drivers ?? [];
check('водители рядом найдены', drivers.length > 0, near);
check('номера в формате Х###ХХ###', drivers.every((d) => /^[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}\d{3}$/.test(d.car.plate)), drivers.slice(0, 3).map((d) => d.car.plate));
check('сортировка по расстоянию', drivers.every((d, index) => index === 0 || d.distanceKm >= drivers[index - 1].distanceKm), drivers.slice(0, 4).map((d) => d.distanceKm));
const localShare = drivers.filter((d) => d.car.regionLabel === 'Москва' || d.car.regionLabel === 'Московская область').length / drivers.length;
check('номеров Москвы и области вокруг точки поиска больше всего', localShare >= 0.4, `доля местных: ${(localShare * 100).toFixed(0)}%`);
console.log(`    есть машины рядом: ${drivers.length}, доля местных ${(Math.round(localShare * 100))}%, примеры: ${drivers.slice(0, 4).map((d) => d.car.plate).join(', ')}`);

const roadDistances = await Promise.all(drivers.slice(0, 8).map((d) => nearestRoadMeters(d.lat, d.lon)));
const sampled = roadDistances.filter((m) => m !== null);
if (sampled.length === 0) {
  console.log('    OSRM не отвечает — проверка «машины на дорогах» пропущена (движение по прямой допустимо)');
} else {
  const worst = Math.max(...sampled);
  check('водители стоят на дорогах', worst <= 200, `дальше всего от дороги: ${worst.toFixed(0)} м`);
  console.log(`    расстояние до ближайшей дороги: от ${Math.min(...sampled).toFixed(0)} до ${worst.toFixed(0)} м (${sampled.length} машин)`);
}

const rideResult = ok(await gql(`mutation { requestRide(input: { pickup: { name: "Тверская", lat: 55.7602, lon: 37.6087 }, dest: { name: "Кутузовский", lat: 55.7426, lon: 37.5350 }, radiusKm: 5 }) {
  etaMin rideMinutes driver { name car { plate } } ride { id plate status distanceKm price finishAt trafficLevel pickupDelayMin trafficPreferred path { lat lon } } } }`, {}, passenger.token));
const ride = rideResult?.requestRide;
check('машина вызвана', ride?.ride?.id !== undefined, ride ?? fail(rideResult));
check('номер поданного водителя из ответа', Boolean(ride?.ride?.plate), ride);
const trafficLevels = ['FREE', 'MODERATE', 'HEAVY', 'UNKNOWN'];
const rideTraffic = ride?.ride;
check(
  'оценка пробок в заказе согласована',
  trafficLevels.includes(rideTraffic?.trafficLevel) &&
    Number.isInteger(rideTraffic?.pickupDelayMin) &&
    rideTraffic.pickupDelayMin >= 0 &&
    typeof rideTraffic?.trafficPreferred === 'boolean' &&
    (rideTraffic.trafficLevel !== 'UNKNOWN' || (rideTraffic.pickupDelayMin === 0 && rideTraffic.trafficPreferred === false)),
  rideTraffic,
);
console.log(`    водитель ${ride?.driver?.name} (${ride?.driver?.car?.plate}) приедет через ${ride?.etaMin} мин, в пути ${ride?.rideMinutes} мин, цена ${ride?.ride?.price} ₽`);
console.log(`    пробки на подаче: ${rideTraffic?.trafficLevel}, +${rideTraffic?.pickupDelayMin} мин${rideTraffic?.trafficPreferred ? ', выбрана не ближайшая машина' : ''}`);

// Маршрут по дорогам длиннее прямой между теми же точками — это и есть признак OSRM.
const routerKind = ok(await gql('query { mapStats { router } }'))?.mapStats?.router ?? 'off';
const pathPoints = ride?.ride?.path ?? [];
const polylineKm = (points) => points.reduce((sum, point, index) => (index ? sum + haversineKm(points[index - 1], point) : 0), 0);
const straightKm = haversineKm({ lat: 55.7602, lon: 37.6087 }, { lat: 55.7426, lon: 37.535 });
if (routerKind === 'osrm') {
  check(
    'поездка проложена по дорогам',
    pathPoints.length > 2 && polylineKm(pathPoints) > straightKm * 1.02,
    `точек: ${pathPoints.length}, длина ${polylineKm(pathPoints).toFixed(1)} км против ${straightKm.toFixed(1)} км прямой`,
  );
  console.log(`    маршрут: ${pathPoints.length} точек, ${polylineKm(pathPoints).toFixed(1)} км по дорогам против ${straightKm.toFixed(1)} км на прямой`);
  const preview = await roadRoute({ lat: 55.7902, lon: 37.5426 }, { lat: 55.7096, lon: 37.6454 });
  const previewStraight = haversineKm({ lat: 55.7902, lon: 37.5426 }, { lat: 55.7096, lon: 37.6454 });
  check(
    'линия предпросмотра ложится на улицы',
    Boolean(preview?.byRoad) && (preview?.path.length ?? 0) > 2 && preview.distanceKm > previewStraight * 1.02,
    `${preview?.distanceKm} км, ${preview?.path.length} точек против ${previewStraight.toFixed(1)} км прямой`,
  );
} else {
  console.log('    router=off — маршрут по прямой, проверка геометрии дорог пропущена');
}

const rides = ok(await gql('query { rides { id plate status distanceKm price trafficLevel pickupDelayMin trafficPreferred } }', {}, passenger.token));
check('заказ виден в списке', (rides?.rides.length ?? 0) >= 1, rides);
const listedRide = rides?.rides.find((item) => item.id === ride.ride?.id);
check(
  'traffic-поля доходят до списка заказов',
  trafficLevels.includes(listedRide?.trafficLevel) &&
    Number.isInteger(listedRide?.pickupDelayMin) &&
    typeof listedRide?.trafficPreferred === 'boolean',
  listedRide,
);

const rideCancel = await gql('mutation ($id: ID!) { cancelRide(id: $id) { id status } }', { id: ride.ride.id }, third.token);
check('отмена чужого заказа запрещена', rideCancel.errors?.[0]?.extensions?.code === 'FORBIDDEN', fail(rideCancel));
const myRideCancel = ok(await gql('mutation ($id: ID!) { cancelRide(id: $id) { id status } }', { id: ride.ride.id }, passenger.token));
check('отмена своего заказа', myRideCancel?.cancelRide?.status === 'CANCELLED', myRideCancel);

const stats = ok(await gql('query { mapStats { kind router total free busy cities { name count } byRegion { label count } } }'));
check('статистика по регионам', (stats?.mapStats?.byRegion.length ?? 0) > 1, stats?.mapStats);
check(
  'парк живёт по нескольким городам',
  (stats?.mapStats?.cities.length ?? 0) >= 10 && stats.mapStats.cities.some((c) => c.name === 'Воронеж'),
  stats?.mapStats?.cities?.map((c) => `${c.name} — ${c.count}`),
);
check('профиль дорог известен сервису', ['osrm', 'off'].includes(stats?.mapStats?.router), stats?.mapStats?.router);
console.log(`    режим дорог: ${stats?.mapStats?.router}, машин: ${stats?.mapStats?.total} (свободных ${stats?.mapStats?.free})`);
console.log('    города парка:', stats?.mapStats?.cities.map((c) => `${c.name} — ${c.count}`).join(', '));
console.log('    распределение номеров:', stats?.mapStats?.byRegion.map((r) => `${r.label} — ${r.count}`).join(', '));

console.log(`\n4. Гонка за последнее место (атомарное списание)`);

const raceTrip = must(ok(await gql('mutation ($input: CreateTripInput!) { createTrip(input: $input) { id seatsAvailable } }', {
  input: {
    from: { name: 'Москва', lat: 55.7602, lon: 37.6087 },
    to: { name: 'Клин', lat: 56.3333, lon: 36.7333 },
    dateTime: new Date(Date.now() + 4 * 86_400_000).toISOString(),
    seats: 1,
    price: 500,
  },
}, driver.token))?.createTrip, 'createTrip(race)');
createdTrips.push({ id: raceTrip.id, token: driver.token });

const rivals = await Promise.all(
  [1, 2, 3].map(async (index) => {
    const registered = ok(await gql(`mutation { register(input: {email: "rival${index}-${stamp}@dtramp.test", password: "kursach123", name: "Ривал ${index}", role: PASSENGER}) { token } }`));
    return registered?.register?.token;
  }),
);

const attempts = await Promise.all(
  rivals.map((token) => gql('mutation ($tripId: ID!) { bookTrip(tripId: $tripId, seats: 1) { id } }', { tripId: raceTrip.id }, token)),
);
const wins = attempts.filter((attempt) => attempt.data?.bookTrip?.id);
check('ровно один победитель гонки', wins.length === 1, attempts.map((attempt) => attempt.errors?.[0]?.message ?? 'ok'));
const raceState = ok(await gql(`query { trip(id: "${raceTrip.id}") { seatsAvailable } }`))?.trip;
check('мест не стало отрицательным', raceState?.seatsAvailable === 0, raceState);

console.log(`\nИтог: ${passed} ok, ${failed} fail`);
process.exitCode = failed === 0 ? 0 : 1;
} finally {
  for (const trip of createdTrips) {
    try {
      const result = await gql('mutation ($id: ID!) { cancelTrip(id: $id) { id status } }', { id: trip.id }, trip.token);
      if (result.data?.cancelTrip?.status !== 'CANCELLED') throw Error(fail(result));
      console.log(`Тестовая поездка ${trip.id} снята с публикации.`);
    } catch (error) {
      console.error(`Не удалось снять тестовую поездку ${trip.id}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

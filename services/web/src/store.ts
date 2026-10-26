import { reactive, computed } from 'vue';
import { api, type Booking, type GeoPoint, type Ride, type RoadRoute, type Role, type Trip, type User, type VDriver } from './api';
import { haversineKm, plural } from './format';

export type Tab = 'trips' | 'ride' | 'mine';
export type PickTarget = 'none' | 'tripFrom' | 'tripTo' | 'rideFrom' | 'rideDest';

/** Круг, который пользователь видит на карте: центр и радиус в километрах. */
export interface VisibleArea {
  lat: number;
  lon: number;
  radiusKm: number;
}

interface State {
  token: string | null;
  user: User | null;
  pickup: GeoPoint;
  destination: GeoPoint | null;
  pickTarget: PickTarget;
  radiusKm: number;
  /**
   * Круг видимой области карты: парк живёт по городам, и машина вне экрана не нужна
   * ни в списке, ни в трафике. Пишется из MapView на каждое движение карты.
   */
  view: VisibleArea | null;
  /** Растёт по требованию «подъехать к точке посадки» (кнопка «Где я») — MapView следит за ним. */
  recenterToken: number;
  drivers: VDriver[];
  driversError: string | null;
  tileErrors: number;
  trips: Trip[] | null;
  search: { from: string; to: string; date: string; seats: number };
  bookings: Booking[];
  myTrips: Trip[];
  rides: Ride[];
  activeRide: Ride | null;
  /** Линия «откуда → куда» до вызова машины: по улицам, если они есть в профиле дорог. */
  preview: RoadRoute | null;
  previewKey: string;
  tab: Tab;
  busy: boolean;
  notice: string | null;
  error: string | null;
}

const center = {
  lat: Number(import.meta.env.VITE_START_LAT ?? 55.7558),
  lon: Number(import.meta.env.VITE_START_LON ?? 37.6173),
};

export const state = reactive<State>({
  token: localStorage.getItem('dtramp.token'),
  user: null,
  pickup: { ...center, name: 'Точка по умолчанию' },
  destination: null,
  pickTarget: 'none',
  radiusKm: 3,
  view: null,
  recenterToken: 0,
  drivers: [],
  driversError: null,
  tileErrors: 0,
  trips: null,
  search: { from: '', to: '', date: '', seats: 1 },
  bookings: [],
  myTrips: [],
  rides: [],
  activeRide: null,
  preview: null,
  previewKey: '',
  tab: 'trips',
  busy: false,
  notice: null,
  error: null,
});

export const isAuthed = computed(() => state.user !== null);
/** Машины внутри круга поиска: они и в списке панели, и в вызове. Остальные — просто парк на карте. */
export const driversInRadius = computed(() => state.drivers.filter((driver) => (driver.distanceKm ?? 0) <= state.radiusKm));
export const nearestFreeDriver = computed(() => driversInRadius.value.find((driver) => driver.status === 'FREE') ?? null);
export const rideDistanceKm = computed(() =>
  state.preview?.distanceKm ?? (state.destination ? haversineKm(state.pickup.lat, state.pickup.lon, state.destination.lat, state.destination.lon) : 0),
);
export const rideEstimate = computed(() => {
  if (!nearestFreeDriver.value || !state.destination) return null;
  const driver = nearestFreeDriver.value;
  return {
    plate: driver.car.plate,
    model: driver.car.model,
    pricePerKm: driver.pricePerKm,
    freeRide: driver.freeRide,
    price: driver.freeRide ? 0 : Math.round(driver.pricePerKm * rideDistanceKm.value),
  };
});

let noticeTimer: ReturnType<typeof setTimeout> | undefined;

function say(message: string) {
  state.notice = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (state.notice = null), 4000);
}

let errorTimer: ReturnType<typeof setTimeout> | undefined;

function fail(message: string) {
  state.error = message;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => (state.error = null), 6000);
}

async function run<T>(action: () => Promise<T>, successText?: string): Promise<T | undefined> {
  state.busy = true;
  state.error = null;
  try {
    const result = await action();
    if (successText) say(successText);
    return result;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return undefined;
  } finally {
    state.busy = false;
  }
}

export const actions = {
  async bootstrap() {
    if (!state.token) return;
    const user = await run(() => api.me(state.token!));
    if (user) state.user = user;
    else localStorage.removeItem('dtramp.token');
  },

  async login(email: string, password: string) {
    const session = await run(() => api.login({ email, password }), 'Вход выполнен');
    if (!session) return false;
    state.token = session.token;
    state.user = session.user;
    localStorage.setItem('dtramp.token', session.token);
    await actions.loadMine();
    return true;
  },

  async register(input: { email: string; password: string; name: string; role: Role; phone?: string }) {
    const session = await run(() => api.register(input), 'Аккаунт создан');
    if (!session) return false;
    state.token = session.token;
    state.user = session.user;
    localStorage.setItem('dtramp.token', session.token);
    return true;
  },

  logout() {
    state.token = null;
    state.user = null;
    state.bookings = [];
    state.myTrips = [];
    state.rides = [];
    state.activeRide = null;
    localStorage.removeItem('dtramp.token');
    say('Вы вышли');
  },

  setPickup(point: GeoPoint) {
    state.pickup = point;
  },

  setView(area: VisibleArea | null) {
    state.view = area;
  },

  /**
   * «Где я»: посадка ставится в текущее место по GPS браузера, карта подъезжает туда.
   * Без этого точка посадки живёт в центре Москвы, и пассажиру из Химок приходится
   * тащить пин через весь экран. Отказ и ошибка разрешения — честная подсказка, а не молчание.
   */
  locateMe(): Promise<void> {
    if (!navigator.geolocation) {
      fail('Браузер не передаёт координаты — выбери точку посадки кликом на карте');
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          state.pickup = { lat: position.coords.latitude, lon: position.coords.longitude, name: 'Я здесь' };
          state.recenterToken += 1;
          void actions.refreshDrivers();
          say('Точка посадки — по координатам устройства');
          resolve();
        },
        () => {
          fail('Местоположение недоступно — выбери точку посадки кликом на карте');
          resolve();
        },
        { enableHighAccuracy: false, timeout: 5000, maximumAge: 300_000 },
      );
    });
  },

  /** Клик по карте: точка назначения заказа или endpoint поездки — зависит от режима. */
  pickFromMap(point: GeoPoint) {
    if (state.pickTarget === 'tripFrom' || state.pickTarget === 'rideFrom') state.pickup = point;
    else if (state.pickTarget === 'tripTo' || state.pickTarget === 'rideDest') state.destination = point;
    state.pickTarget = 'none';
  },

  async refreshDrivers() {
    try {
      // Спрашиваем круг поиска и то, что видно на экране. Без второго карта за его
      // краями пустая, хотя машины там есть; без первого панель теряла бы варианты.
      const view = state.view && state.view.radiusKm > state.radiusKm ? state.view : undefined;
      const result = await api.driversNear({
        lat: state.pickup.lat,
        lon: state.pickup.lon,
        radiusKm: state.radiusKm,
        view,
      });
      state.drivers = result.drivers;
      state.driversError = null;
    } catch (error) {
      state.driversError = error instanceof Error ? error.message : String(error);
    }
  },

  /**
   * Линия предпросмотра «откуда → куда». Держим ключ пары точек: пин двигают
   * перетаскиванием, и на каждое движение дёргать роутер не нужно.
   */
  async refreshPreview() {
    const destination = state.destination;
    if (!destination || state.activeRide) {
      state.preview = null;
      state.previewKey = '';
      return;
    }
    const key = [state.pickup.lat, state.pickup.lon, destination.lat, destination.lon].map((value) => value.toFixed(4)).join(',');
    if (state.previewKey === key) return;
    state.previewKey = key;
    state.preview = null;
    const road = await api.roadRoute(state.pickup, destination).catch(() => null);
    // за время запроса точки могли уехать — не подставляем чужой маршрут
    if (road && state.previewKey === key) state.preview = road;
  },

  async searchTrips() {
    const trips = await run(() =>
      api.trips({
        from: state.search.from || undefined,
        to: state.search.to || undefined,
        date: state.search.date || undefined,
        seats: state.search.seats || undefined,
        limit: 20,
      }),
    );
    if (trips) state.trips = trips;
  },

  async createTrip(input: { dateTime: string; seats: number; price: number; comment: string }) {
    const destination = state.destination;
    if (!destination) {
      fail('Сначала выбери точку назначения на карте');
      return false;
    }
    const from = { ...state.pickup, name: state.pickup.name || 'Точка на карте' };
    const trip = await run(
      () =>
        api.createTrip(
          {
            from,
            to: destination,
            dateTime: new Date(input.dateTime).toISOString(),
            seats: input.seats,
            price: input.price,
            comment: input.comment || undefined,
          },
          state.token!,
        ),
      'Поездка опубликована',
    );
    if (!trip) return false;
    state.myTrips = [trip, ...state.myTrips];
    await actions.searchTrips();
    return true;
  },

  async bookTrip(tripId: string, seats: number) {
    if (!state.token) {
      fail('Чтобы забронировать место, войди');
      return false;
    }
    const booking = await run(
      () => api.bookTrip(tripId, seats, state.token!),
      `Забронировано ${plural(seats, 'место', 'места', 'мест')}`,
    );
    if (!booking) return false;
    state.bookings = [booking, ...state.bookings];
    await actions.searchTrips();
    return true;
  },

  async cancelBooking(id: string) {
    const booking = await run(() => api.cancelBooking(id, state.token!), 'Бронь отменена');
    if (!booking) return false;
    state.bookings = state.bookings.map((item) => (item.id === booking.id ? booking : item));
    await actions.searchTrips();
    return true;
  },

  async cancelTrip(id: string) {
    const trip = await run(() => api.cancelTrip(id, state.token!), 'Поездка отменена');
    if (!trip) return false;
    state.myTrips = state.myTrips.map((item) => (item.id === trip.id ? trip : item));
    await actions.searchTrips();
    return true;
  },

  async requestRide() {
    // destiny сохраняем в локальную переменную: сужение типа не переживает await
    const destination = state.destination;
    if (!destination) {
      fail('Выбери точку назначения на карте');
      return false;
    }
    const result = await run(
      () =>
        api.requestRide(
          {
            pickup: { ...state.pickup, name: state.pickup.name || 'Точка на карте' },
            dest: destination,
            radiusKm: state.radiusKm,
          },
          state.token!,
        ),
      'Машина вызвана',
    );
    if (!result) return false;
    state.activeRide = result.ride;
    state.rides = [result.ride, ...state.rides];
    await actions.refreshDrivers();
    return true;
  },

  async cancelRide(id: string) {
    const ride = await run(() => api.cancelRide(id, state.token!), 'Заказ отменён');
    if (!ride) return false;
    if (state.activeRide?.id === id) state.activeRide = null;
    state.rides = state.rides.map((item) => (item.id === ride.id ? ride : item));
    await actions.refreshDrivers();
    return true;
  },

  async loadMine() {
    if (!state.token) return;
    const loaded = await run(async () => {
      const token = state.token!;
      const [bookings, trips, rides] = await Promise.all([api.bookings(token), api.myTrips(token), api.rides(token)]);
      return { bookings, trips, rides };
    });
    if (!loaded) return;
    state.bookings = loaded.bookings;
    state.myTrips = loaded.trips;
    state.rides = loaded.rides;
    state.activeRide = loaded.rides.find((ride) => ride.status === 'ACCEPTED') ?? null;
  },
};

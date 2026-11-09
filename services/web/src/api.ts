export interface GeoPoint {
  name?: string;
  lat: number;
  lon: number;
}

export type Role = 'DRIVER' | 'PASSENGER';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  phone?: string;
  rating: number;
  tripsCount: number;
  /** Внутренний кошелёк, ₽. */
  balance: number;
}

export interface Trip {
  id: string;
  driverId: string;
  driver?: User | null;
  from: GeoPoint;
  to: GeoPoint;
  dateTime: string;
  seatsTotal: number;
  seatsAvailable: number;
  price: number;
  distanceKm?: number;
  status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';
  comment?: string;
}

export interface Booking {
  id: string;
  tripId: string;
  trip?: Trip | null;
  userId: string;
  passenger?: User | null;
  seats: number;
  priceTotal: number;
  status: 'CONFIRMED' | 'CANCELLED';
}

export interface VDriver {
  id: string;
  name: string;
  car: { model: string; plate: string; regionLabel?: string };
  rating: number;
  lat: number;
  lon: number;
  status: 'FREE' | 'BUSY';
  pricePerKm: number;
  freeRide: boolean;
  speedKmh: number;
  distanceKm?: number;
}

export interface Ride {
  id: string;
  driverId: string;
  driverName: string;
  plate: string;
  carModel: string;
  pickup: GeoPoint;
  dest: GeoPoint;
  distanceKm: number;
  etaMin: number;
  finishAt: string;
  /** Полилиния маршрута по дорогам; пустая — если роутер был недоступен. */
  path: GeoPoint[];
  price: number;
  status: 'ACCEPTED' | 'DRIVER_ARRIVED' | 'BOARDED' | 'ARRIVED' | 'COMPLETED' | 'CANCELLED';
  refundPending: boolean;
  trafficLevel: 'FREE' | 'MODERATE' | 'HEAVY' | 'UNKNOWN';
  /** На сколько минут пробки удлинили подачу. */
  pickupDelayMin: number;
  /** Выбрана не ближайшая машина, потому что ближайшая стояла в пробке. */
  trafficPreferred: boolean;
}

export interface RoadRoute {
  /** false — дорог в графе под этими точками нет, линия и километры посчитаны по прямой. */
  byRoad: boolean;
  distanceKm: number;
  durationMin: number;
  path: GeoPoint[];
}

const USER_FIELDS = 'id email name role phone rating tripsCount balance';
const POINT_FIELDS = 'name lat lon';
const TRIP_FIELDS = `id driverId dateTime seatsTotal seatsAvailable price distanceKm status comment
  from { ${POINT_FIELDS} } to { ${POINT_FIELDS} } driver { ${USER_FIELDS} }`;
const BOOKING_FIELDS = `id tripId userId seats priceTotal status
  trip { id dateTime status from { ${POINT_FIELDS} } to { ${POINT_FIELDS} } price } passenger { ${USER_FIELDS} }`;
const DRIVER_FIELDS = `id name rating lat lon status pricePerKm freeRide speedKmh distanceKm
  car { model plate regionLabel }`;
const RIDE_FIELDS =
  'id driverId driverName plate carModel distanceKm etaMin finishAt price status refundPending trafficLevel pickupDelayMin trafficPreferred pickup { name lat lon } dest { name lat lon } path { lat lon }';
const ROAD_FIELDS = 'byRoad distanceKm durationMin path { lat lon }';

async function request<T>(query: string, variables: Record<string, unknown> = {}, token?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw new Error('Шлюз недоступен: проверь, что поднят api-gateway (docker compose up -d)');
  }

  const body = (await response.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null;
  if (body?.errors?.length) throw new Error(body.errors[0]!.message);
  if (!body?.data) throw new Error(`Шлюз ответил ${response.status} без данных`);
  return body.data;
}

export const api = {
  register(input: { email: string; password: string; name: string; role: Role; phone?: string }) {
    return request<{ register: { token: string; user: User } }>(
      `mutation ($input: RegisterInput!) { register(input: $input) { token user { ${USER_FIELDS} } } }`,
      { input },
    ).then((data) => data.register);
  },

  login(input: { email: string; password: string }) {
    return request<{ login: { token: string; user: User } }>(
      `mutation ($input: LoginInput!) { login(input: $input) { token user { ${USER_FIELDS} } } }`,
      { input },
    ).then((data) => data.login);
  },

  me(token: string) {
    return request<{ me: User }>(`query { me { ${USER_FIELDS} } }`, {}, token).then((data) => data.me);
  },

  trips(args: { from?: string; to?: string; date?: string; seats?: number; limit?: number }) {
    return request<{ trips: Trip[] }>(
      `query ($from: String, $to: String, $date: String, $seats: Int, $limit: Int) {
         trips(from: $from, to: $to, date: $date, seats: $seats, limit: $limit) { ${TRIP_FIELDS} }
       }`,
      args,
    ).then((data) => data.trips);
  },

  createTrip(input: { from: GeoPoint; to: GeoPoint; dateTime: string; seats: number; price: number; comment?: string }, token: string) {
    return request<{ createTrip: Trip }>(
      `mutation ($input: CreateTripInput!) { createTrip(input: $input) { ${TRIP_FIELDS} } }`,
      { input },
      token,
    ).then((data) => data.createTrip);
  },

  cancelTrip(id: string, token: string) {
    return request<{ cancelTrip: Trip }>(`mutation ($id: ID!) { cancelTrip(id: $id) { ${TRIP_FIELDS} } }`, { id }, token).then(
      (data) => data.cancelTrip,
    );
  },

  bookTrip(tripId: string, seats: number, token: string) {
    return request<{ bookTrip: Booking }>(
      `mutation ($tripId: ID!, $seats: Int!) { bookTrip(tripId: $tripId, seats: $seats) { ${BOOKING_FIELDS} } }`,
      { tripId, seats },
      token,
    ).then((data) => data.bookTrip);
  },

  bookings(token: string) {
    return request<{ bookings: Booking[] }>(`query { bookings { ${BOOKING_FIELDS} } }`, {}, token).then((data) => data.bookings);
  },

  myTrips(token: string) {
    return request<{ myTrips: Trip[] }>(`query { myTrips { ${TRIP_FIELDS} } }`, {}, token).then((data) => data.myTrips);
  },

  cancelBooking(id: string, token: string) {
    return request<{ cancelBooking: Booking }>(
      `mutation ($id: ID!) { cancelBooking(id: $id) { ${BOOKING_FIELDS} } }`,
      { id },
      token,
    ).then((data) => data.cancelBooking);
  },

  /**
   * Машины круга поиска + круга обзора. `view` — то, что видно на экране: парк
   * распределён по городам, и отдавать всю Россию на каждый опрос незачем.
   */
  driversNear(input: {
    lat: number;
    lon: number;
    radiusKm: number;
    view?: { lat: number; lon: number; radiusKm: number };
  }) {
    const { lat, lon, radiusKm, view } = input;
    return request<{ driversNear: { radiusKm: number; drivers: VDriver[] } }>(
      `query ($lat: Float!, $lon: Float!, $radiusKm: Float, $viewLat: Float, $viewLon: Float, $viewRadiusKm: Float) {
         driversNear(lat: $lat, lon: $lon, radiusKm: $radiusKm, viewLat: $viewLat, viewLon: $viewLon, viewRadiusKm: $viewRadiusKm) {
           radiusKm drivers { ${DRIVER_FIELDS} }
         }
       }`,
      { lat, lon, radiusKm, viewLat: view?.lat, viewLon: view?.lon, viewRadiusKm: view?.radiusKm },
    ).then((data) => data.driversNear);
  },

  roadRoute(from: GeoPoint, to: GeoPoint) {
    return request<{ roadRoute: RoadRoute }>(
      `query ($from: GeoPointInput!, $to: GeoPointInput!) { roadRoute(from: $from, to: $to) { ${ROAD_FIELDS} } }`,
      { from, to },
    ).then((data) => data.roadRoute);
  },

  requestRide(input: { pickup: GeoPoint; dest: GeoPoint; radiusKm?: number; driverId?: string }, token: string) {
    return request<{
      requestRide: { ride: Ride; driver: VDriver; etaMin: number; rideMinutes: number };
    }>(
      `mutation ($input: RequestRideInput!) {
         requestRide(input: $input) { etaMin rideMinutes driver { ${DRIVER_FIELDS} } ride { ${RIDE_FIELDS} } }
       }`,
      { input },
      token,
    ).then((data) => data.requestRide);
  },

  rides(token: string) {
    return request<{ rides: Ride[] }>(`query { rides { ${RIDE_FIELDS} } }`, {}, token).then((data) => data.rides);
  },

  cancelRide(id: string, token: string) {
    return request<{ cancelRide: Ride }>(`mutation ($id: ID!) { cancelRide(id: $id) { ${RIDE_FIELDS} } }`, { id }, token).then(
      (data) => data.cancelRide,
    );
  },

  boardRide(id: string, token: string) {
    return request<{ boardRide: Ride }>(`mutation ($id: ID!) { boardRide(id: $id) { ${RIDE_FIELDS} } }`, { id }, token).then(
      (data) => data.boardRide,
    );
  },

  exitRide(id: string, token: string) {
    return request<{ exitRide: Ride }>(`mutation ($id: ID!) { exitRide(id: $id) { ${RIDE_FIELDS} } }`, { id }, token).then(
      (data) => data.exitRide,
    );
  },

  topUpBalance(amount: number, token: string) {
    return request<{ topUpBalance: User }>(
      `mutation ($amount: Float!) { topUpBalance(amount: $amount) { ${USER_FIELDS} } }`,
      { amount },
      token,
    ).then((data) => data.topUpBalance);
  },
};

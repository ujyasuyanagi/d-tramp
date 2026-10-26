export const typeDefs = /* GraphQL */ `
  "D-Tramp — голосуй, едешь. Единая точка входа: user-service, trip-service, map-service."
  type Query {
    health: Health!

    "Текущий пользователь по JWT."
    me: User!

    "Профиль пользователя (водителя поездки, например)."
    user(id: ID!): User

    "Поездка по id."
    trip(id: ID!): Trip

    "Публичный поиск поездок: без авторизации."
    trips(from: String, to: String, date: String, seats: Int, driverId: ID, limit: Int): [Trip!]!

    "Поездки текущего пользователя как водителя."
    myTrips: [Trip!]!

    "Брони текущего пользователя; tripId — брониров этой поездки (только для её водителя)."
    bookings(tripId: ID): [Booking!]!

    "Машины вокруг точки поиска плюс видимая область карты (map-service)."
    driversNear(lat: Float!, lon: Float!, radiusKm: Float, viewLat: Float, viewLon: Float, viewRadiusKm: Float): DriversResult!

    "Линия маршрута между двумя точками: по улицам, а там, где дорог в графе нет, — по прямой."
    roadRoute(from: GeoPointInput!, to: GeoPointInput!): RoadRoute!

    "Распределение госномеров по регионам среди виртуальных водителей."
    mapStats: MapStats!

    "Заказы вызова машины текущего пользователя."
    rides: [Ride!]!
    ride(id: ID!): Ride
  }

  type Mutation {
    register(input: RegisterInput!): AuthPayload!
    login(input: LoginInput!): AuthPayload!
    updateProfile(input: UpdateProfileInput!): User!

    createTrip(input: CreateTripInput!): Trip!
    cancelTrip(id: ID!): Trip!
    bookTrip(tripId: ID!, seats: Int = 1): Booking!
    cancelBooking(id: ID!): Booking!

    "Вызов виртуального водителя рядом."
    requestRide(input: RequestRideInput!): RideResult!
    cancelRide(id: ID!): Ride!
  }

  enum Role { DRIVER PASSENGER }
  enum TripStatus { SCHEDULED COMPLETED CANCELLED }
  enum BookingStatus { CONFIRMED CANCELLED }
  enum DriverStatus { FREE BUSY }
  enum RideStatus { ACCEPTED COMPLETED CANCELLED }
  enum TrafficLevel { FREE MODERATE HEAVY UNKNOWN }

  type Health { ok: Boolean! service: String! }

  type GeoPoint {
    name: String
    lat: Float!
    lon: Float!
  }

  type User {
    id: ID!
    email: String!
    name: String!
    role: Role!
    phone: String
    rating: Float!
    tripsCount: Int!
  }

  type AuthPayload {
    token: String!
    user: User!
  }

  type Trip {
    id: ID!
    driverId: ID!
    "Водитель поездки (данные из user-service)."
    driver: User
    from: GeoPoint!
    to: GeoPoint!
    "ISO-дата и время выезда."
    dateTime: String!
    seatsTotal: Int!
    seatsAvailable: Int!
    "Цена за место, ₽."
    price: Float!
    distanceKm: Float
    status: TripStatus!
    comment: String
  }

  type Booking {
    id: ID!
    tripId: ID!
    trip: Trip
    userId: ID!
    passenger: User
    seats: Int!
    priceTotal: Float!
    status: BookingStatus!
  }

  type Car {
    model: String!
    "Госномер вида Х###ХХ###, сгенерирован по распределению регионов."
    plate: String!
    regionLabel: String
  }

  type VDriver {
    id: ID!
    name: String!
    car: Car!
    rating: Float!
    lat: Float!
    lon: Float!
    status: DriverStatus!
    pricePerKm: Float!
    "Акция «бесплатная поездка»."
    freeRide: Boolean!
    speedKmh: Float!
    "Км от точки поиска."
    distanceKm: Float
  }

  type DriversResult {
    center: GeoPoint!
    radiusKm: Float!
    drivers: [VDriver!]!
  }

  type RegionBucket {
    label: String!
    count: Int!
  }

  type RoadRoute {
    "false — под точками нет дорог в графе: линия и километры посчитаны по прямой."
    byRoad: Boolean!
    distanceKm: Float!
    "Оценка в пути, минуты (для прямой — при 60 км/ч)."
    durationMin: Float!
    path: [GeoPoint!]!
  }

  type MapStats {
    kind: String!
    "Профиль дорог: osrm — по реальным улицам, off — по прямой."
    router: String!
    total: Int!
    free: Int!
    busy: Int!
    "Города, в которых живёт парк."
    cities: [CityBucket!]!
    byRegion: [RegionBucket!]!
  }

  type CityBucket {
    name: String!
    count: Int!
  }

  type Ride {
    id: ID!
    driverId: ID!
    driverName: String!
    plate: String!
    carModel: String!
    pickup: GeoPoint!
    dest: GeoPoint!
    distanceKm: Float!
    "Минут до подачи машины."
    etaMin: Int!
    finishAt: String!
    "Полилиния маршрута по дорогам (от OSRM), для линии на карте."
    path: [GeoPoint!]!
    price: Float!
    status: RideStatus!
    "Пробки на маршруте подачи в момент вызова."
    trafficLevel: TrafficLevel!
    "На сколько минут пробки удлинили подачу."
    pickupDelayMin: Int!
    "Выбрана не ближайшая машина: ближайшая стояла в пробке."
    trafficPreferred: Boolean!
  }

  type RideResult {
    ride: Ride!
    driver: VDriver!
    etaMin: Int!
    rideMinutes: Int!
  }

  input GeoPointInput {
    name: String
    lat: Float!
    lon: Float!
  }

  input RegisterInput {
    email: String!
    password: String!
    name: String!
    role: Role = PASSENGER
    phone: String
  }

  input LoginInput {
    email: String!
    password: String!
  }

  input UpdateProfileInput {
    name: String
    phone: String
    role: Role
    password: String
  }

  input CreateTripInput {
    from: GeoPointInput!
    to: GeoPointInput!
    dateTime: String!
    seats: Int!
    "Цена за место, ₽."
    price: Float!
    comment: String
  }

  input RequestRideInput {
    pickup: GeoPointInput!
    dest: GeoPointInput!
    radiusKm: Float
  }
`;

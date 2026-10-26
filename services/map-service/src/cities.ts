/**
 * Города, в которых живёт виртуальный парк. Один источник правды: по этой же таблице
 * `scripts/osrm-prepare-pbf.sh` режет bbox дорог — машине неоткуда брать улицы, если
 * город есть в парке, но отсутствует в графе OSRM.
 */
export interface CitySpawn {
  key: string;
  name: string;
  /** Код субъекта для госномера: водитель в Твери едет на «69», а не на московском. */
  region: string;
  lat: number;
  lon: number;
  /** Радиус «дома»: в нём машина ищет следующий заказ, км. */
  radiusKm: number;
  /** Относительная доля парка. */
  weight: number;
}

const MOSCOW: CitySpawn = { key: 'msk', name: 'Москва', region: '77', lat: 55.7558, lon: 37.6173, radiusKm: 11, weight: 20 };

/** Крупные города Московской области: спутники, в которые реальная Москва упирается кольцом. */
const MOZHIKA: CitySpawn[] = [
  { key: 'himki', name: 'Химки', region: '50', lat: 55.8898, lon: 37.4353, radiusKm: 4, weight: 3 },
  { key: 'podolsk', name: 'Подольск', region: '50', lat: 55.4258, lon: 37.5497, radiusKm: 4, weight: 3 },
  { key: 'balashikha', name: 'Балашиха', region: '50', lat: 55.7964, lon: 37.9381, radiusKm: 4, weight: 3 },
  { key: 'mytishchi', name: 'Мытищи', region: '50', lat: 55.9116, lon: 37.7361, radiusKm: 4, weight: 2.5 },
  { key: 'korolev', name: 'Королёв', region: '50', lat: 55.9185, lon: 37.8369, radiusKm: 3.5, weight: 2.5 },
  { key: 'lyubertsy', name: 'Люберцы', region: '50', lat: 55.6775, lon: 37.8876, radiusKm: 3.5, weight: 2.5 },
  { key: 'odintsovo', name: 'Одинцово', region: '50', lat: 55.6781, lon: 37.2631, radiusKm: 4, weight: 2.5 },
  { key: 'sergiev', name: 'Сергиев Посад', region: '50', lat: 56.3102, lon: 38.13, radiusKm: 3.5, weight: 2 },
  { key: 'kolomna', name: 'Коломна', region: '50', lat: 55.0808, lon: 38.7796, radiusKm: 4, weight: 2 },
];

/** Столицы ЦФО: заказ едет по своему городу, межгород остаётся прямым участком. */
const TSFO: CitySpawn[] = [
  { key: 'tver', name: 'Тверь', region: '69', lat: 56.8587, lon: 35.9176, radiusKm: 5, weight: 3 },
  { key: 'slts', name: 'Смоленск', region: '67', lat: 54.7818, lon: 32.0498, radiusKm: 5, weight: 2.5 },
  { key: 'bryansk', name: 'Брянск', region: '32', lat: 53.2524, lon: 34.383, radiusKm: 5, weight: 2.5 },
  { key: 'kaluga', name: 'Калуга', region: '40', lat: 54.5091, lon: 36.2534, radiusKm: 5, weight: 2.5 },
  { key: 'orel', name: 'Орёл', region: '57', lat: 52.9651, lon: 36.0737, radiusKm: 5, weight: 2.5 },
  { key: 'kursk', name: 'Курск', region: '46', lat: 51.7304, lon: 36.1912, radiusKm: 5, weight: 2.5 },
  { key: 'belgorod', name: 'Белгород', region: '31', lat: 50.5999, lon: 36.5872, radiusKm: 5, weight: 2.5 },
  { key: 'voronezh', name: 'Воронеж', region: '36', lat: 51.6606, lon: 39.2003, radiusKm: 6, weight: 3.5 },
  { key: 'lipetsk', name: 'Липецк', region: '48', lat: 52.6103, lon: 39.5947, radiusKm: 5, weight: 2.5 },
  { key: 'tambov', name: 'Тамбов', region: '68', lat: 52.7212, lon: 41.4525, radiusKm: 5, weight: 2.5 },
  { key: 'ryazan', name: 'Рязань', region: '62', lat: 54.6297, lon: 39.7044, radiusKm: 5, weight: 3 },
  { key: 'tula', name: 'Тула', region: '71', lat: 54.1959, lon: 37.6182, radiusKm: 5, weight: 3 },
  { key: 'vladimir', name: 'Владимир', region: '33', lat: 56.13, lon: 40.4064, radiusKm: 5, weight: 2.5 },
  { key: 'ivanovo', name: 'Иваново', region: '37', lat: 57.0005, lon: 40.9697, radiusKm: 4.5, weight: 2.5 },
  { key: 'yaroslavl', name: 'Ярославль', region: '76', lat: 57.6261, lon: 39.8845, radiusKm: 5.5, weight: 3 },
  { key: 'kostroma', name: 'Кострома', region: '44', lat: 57.7273, lon: 40.9143, radiusKm: 4.5, weight: 2.5 },
];

export const CITY_SPAWNS: CitySpawn[] = [MOSCOW, ...MOZHIKA, ...TSFO];

const BY_KEY = new Map(CITY_SPAWNS.map((city) => [city.key, city] as const));

/**
 * Ramer–Douglas-подобного запаса не нужно: важен только порядок — bbox закрывает круг спавна
 * целиком, иначе ближайшая улица окажется за вырезанным краем и машина встанет в поле.
 */
export function roadBbox(city: CitySpawn, marginKm = 6): string {
  const reach = city.radiusKm + marginKm;
  const degreesPerKm = 1 / 111.32;
  const latSpan = reach * degreesPerKm;
  const lonSpan = reach / (111.32 * Math.cos((city.lat * Math.PI) / 180));
  return [
    (city.lon - lonSpan).toFixed(4),
    (city.lat - latSpan).toFixed(4),
    (city.lon + lonSpan).toFixed(4),
    (city.lat + latSpan).toFixed(4),
  ].join(',');
}

export interface CitySelection {
  /**
   * Значение MAP_CITIES: города таблицы через `;` (`msk; tver`) или ad-hoc точки
   * `широта,долгота[,код региона]`. Пусто — весь список: демо по Москве, области и ЦФО.
   */
  allow: string;
  /** Радиус ad-hoc точки, у которой нет строки в таблице, км. */
  adHocRadiusKm: number;
}

/**
 * Разбор MAP_CITIES. Точка координатами нужна, когда OSRM собран по другому региону
 * (README, «быстрый старт в другом городе») — города из таблицы тогда не имеют дорог.
 */
export function selectCities(selection: CitySelection): CitySpawn[] {
  const entries = selection.allow
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.length) return CITY_SPAWNS;

  return entries.map((entry, index) => {
    if (!entry.includes(',')) {
      const known = BY_KEY.get(entry);
      if (known) return known;
      throw new Error(`MAP_CITIES: неизвестный город «${entry}». Есть: ${CITY_SPAWNS.map((city) => city.key).join(', ')}`);
    }
    const [lat = '', lon = '', region = '77'] = entry.split(',').map((part) => part.trim());
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
      throw new Error(`MAP_CITIES: «${entry}» — ждём «широта,долгота[,код региона]»`);
    }
    return {
      key: `ad-hoc-${index}`,
      name: `Точка ${Number(lat).toFixed(3)}, ${Number(lon).toFixed(3)}`,
      region,
      lat: Number(lat),
      lon: Number(lon),
      radiusKm: selection.adHocRadiusKm,
      weight: 1,
    };
  });
}

/**
 * Сколько машин в каждом городе: доли весов, округлённые методом наибольшего остатка, —
 * сумма ровно `count`, иначе при 90 машинах и 25 городах недосчитаемся половины парка.
 */
export function spreadDrivers(count: number, cities: CitySpawn[]): CitySpawn[] {
  const totalWeight = cities.reduce((sum, city) => sum + city.weight, 0);
  const shares = cities.map((city) => {
    const exact = (city.weight / totalWeight) * count;
    return { city, whole: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let used = shares.reduce((sum, share) => sum + share.whole, 0);
  for (const share of [...shares].sort((a, b) => b.rest - a.rest)) {
    if (used >= count) break;
    share.whole += 1;
    used += 1;
  }
  return shares.flatMap((share) => Array.from({ length: share.whole }, () => share.city));
}

import { createRng, type Rng } from './rand';

/**
 * Номера выдаются неравномерно: подавляющая масса водителей — «местные»,
 * соседние области реже, дальние регионы — редкие гости.
 */
export interface RegionGroup {
  key: string;
  label: string;
  codes: string[];
  /** Веса соседних групп для спавна в этой группе. */
  neighbors: Record<string, number>;
}

const HOME_WEIGHT = 58;
const RARE_WEIGHT = 1.2;

export const REGION_GROUPS: RegionGroup[] = [
  {
    key: 'msk',
    label: 'Москва',
    codes: ['77', '97', '99', '177', '777', '797', '997'],
    neighbors: { mo: 18, tver: 6, kaluga: 5, spb: 4, prim: 2, krsk: 2, nsk: 1.5, irk: 1.5 },
  },
  {
    key: 'mo',
    label: 'Московская область',
    codes: ['50', '90', '150', '190', '750'],
    neighbors: { msk: 34, tver: 5, kaluga: 4, spb: 3 },
  },
  { key: 'tver', label: 'Тверская область', codes: ['69'], neighbors: { msk: 30, mo: 10, kaluga: 4 } },
  { key: 'kaluga', label: 'Калужская область', codes: ['40'], neighbors: { msk: 30, mo: 10, tver: 4 } },
  // Столицы ЦФО, где живёт часть парка: соседями идут Москва и область — «гости» из столицы
  // на номере своего региона выглядят правдоподобнее, чем случайный приморский код.
  { key: 'smolensk', label: 'Смоленская область', codes: ['67'], neighbors: { msk: 22, tver: 6, bryansk: 5 } },
  { key: 'bryansk', label: 'Брянская область', codes: ['32', '132'], neighbors: { msk: 20, smolensk: 6, orel: 6, kaluga: 4 } },
  { key: 'orel', label: 'Орловская область', codes: ['57'], neighbors: { msk: 20, bryansk: 6, tula: 5, kursk: 5 } },
  { key: 'kursk', label: 'Курская область', codes: ['46', '146'], neighbors: { msk: 18, belgorod: 8, orel: 6 } },
  { key: 'belgorod', label: 'Белгородская область', codes: ['31', '131'], neighbors: { msk: 18, kursk: 8, voronezh: 6 } },
  { key: 'voronezh', label: 'Воронежская область', codes: ['36', '136'], neighbors: { msk: 16, belgorod: 6, lipetsk: 6, tambov: 5 } },
  { key: 'lipetsk', label: 'Липецкая область', codes: ['48'], neighbors: { msk: 18, voronezh: 6, tambov: 6 } },
  { key: 'tambov', label: 'Тамбовская область', codes: ['68'], neighbors: { msk: 18, voronezh: 6, lipetsk: 6, ryazan: 5 } },
  { key: 'ryazan', label: 'Рязанская область', codes: ['62'], neighbors: { msk: 26, mo: 8, tula: 6, tambov: 5 } },
  { key: 'tula', label: 'Тульская область', codes: ['71'], neighbors: { msk: 28, mo: 8, kaluga: 6, ryazan: 5 } },
  { key: 'vladimir', label: 'Владимирская область', codes: ['33'], neighbors: { msk: 26, mo: 8, ivanovo: 6, kostroma: 4 } },
  { key: 'ivanovo', label: 'Ивановская область', codes: ['37'], neighbors: { msk: 20, vladimir: 7, kostroma: 6 } },
  { key: 'yaroslavl', label: 'Ярославская область', codes: ['76'], neighbors: { msk: 26, mo: 8, kostroma: 7, vladimir: 5 } },
  { key: 'kostroma', label: 'Костромская область', codes: ['44'], neighbors: { msk: 20, yaroslavl: 7, ivanovo: 6, vladimir: 5 } },
  { key: 'spb', label: 'Санкт-Петербург', codes: ['78', '98', '178'], neighbors: { msk: 12, novgorod: 6 } },
  { key: 'prim', label: 'Приморский край', codes: ['25', '125'], neighbors: { khab: 4, yakutia: 3 } },
  { key: 'krsk', label: 'Красноярский край', codes: ['24', '84', '88', '124'], neighbors: { nsk: 6, irk: 5 } },
  { key: 'nsk', label: 'Новосибирская область', codes: ['54', '154'], neighbors: { krsk: 6, irk: 4 } },
  { key: 'irk', label: 'Иркутская область', codes: ['38', '85', '138'], neighbors: { krsk: 6, buryatia: 4 } },
  // Группы только «для гостей»: сами в Москве не спавнятся, но иногда мелькают на номере.
  { key: 'khab', label: 'Хабаровский край', codes: ['27', '127'], neighbors: {} },
  { key: 'novgorod', label: 'Новгородская область', codes: ['53'], neighbors: {} },
  { key: 'yakutia', label: 'Республика Саха', codes: ['14'], neighbors: {} },
  { key: 'buryatia', label: 'Республика Бурятия', codes: ['03', '80', '103'], neighbors: {} },
];

const BY_CODE = new Map(REGION_GROUPS.flatMap((group) => group.codes.map((code) => [code, group] as const)));

export interface RegionProbability {
  label: string;
  code: string;
  weight: number;
}

/** Распределение кодов региона для точки спавна: свой регион — основная масса. */
export function distributionFor(spawnCode: string): RegionProbability[] {
  const home = BY_CODE.get(spawnCode);
  if (!home) {
    // Неизвестный спавн: считаем его «местным» и добавляем редкие дальние регионы.
    return [
      { label: `Регион ${spawnCode}`, code: spawnCode, weight: 70 },
      ...REGION_GROUPS.flatMap((group) =>
        group.codes.map((code) => ({ label: group.label, code, weight: RARE_WEIGHT / group.codes.length })),
      ),
    ];
  }

  const entries: RegionProbability[] = [];
  const push = (group: RegionGroup, groupWeight: number) => {
    for (const code of group.codes) entries.push({ label: group.label, code, weight: groupWeight / group.codes.length });
  };

  push(home, HOME_WEIGHT);
  const seen = new Set([home.key]);
  for (const [key, weight] of Object.entries(home.neighbors)) {
    const neighbor = REGION_GROUPS.find((group) => group.key === key);
    if (!neighbor) continue;
    push(neighbor, weight);
    seen.add(neighbor.key);
  }
  for (const group of REGION_GROUPS) {
    if (!seen.has(group.key)) push(group, RARE_WEIGHT);
  }

  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  return entries.map((entry) => ({ ...entry, weight: Math.round((entry.weight / total) * 1000) / 10 }));
}

/** Только цифры: «077» для одно-двухзначных кодов, как на настоящих номерах. */
function formatRegionCode(code: string) {
  return code.length >= 3 ? code : code.padStart(3, '0');
}

const LETTERS = 'АВЕКМНОРСТУХ';
const DIGITS = '0123456789';

function randomRun(alphabet: string, length: number, rng: Rng) {
  return Array.from({ length }, () => alphabet[rng.int(0, alphabet.length - 1)]).join('');
}

/** Формат Х###ХХ### — буквы только из АВЕКМНОРСТУХ. */
export function generatePlate(spawnCode: string, rng: Rng): string {
  const distribution = distributionFor(spawnCode);
  const region = rng.weighted(distribution.map((entry) => ({ item: entry, weight: entry.weight })));
  return `${randomRun(LETTERS, 1, rng)}${randomRun(DIGITS, 3, rng)}${randomRun(LETTERS, 2, rng)}${formatRegionCode(region.code)}`;
}

export function regionLabelOf(plate: string): string {
  const digits = plate.slice(-3);
  for (const candidate of [digits, digits.replace(/^0/, ''), digits.replace(/^00?/, '')]) {
    const group = BY_CODE.get(candidate);
    if (group) return group.label;
  }
  return `Регион ${Number(digits)}`;
}

export const PLATE_RE = /^[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}\d{3}$/;

/** Демонстрационный набор номеров — используется тестами и README-скриншотами. */
export function samplePlates(spawnCode: string, count: number, seed: number): string[] {
  const rng = createRng(seed);
  return Array.from({ length: count }, () => generatePlate(spawnCode, rng));
}

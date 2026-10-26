/**
 * Печатает bbox для выгрузки дорог: коридор Москва + МО одним box, каждый город из
 * cities.ts — своим (по одному в строке). Один источник списка городов: там, где симуляции
 * нужен город, там же graph-строителю нужна выгрузка улиц, иначе машины встанут в поле.
 *
 *   scripts/osrm-city-boxes.ts <minLon,minLat,maxLon,maxLat>
 */
import { CITY_SPAWNS, roadBbox } from '../services/map-service/src/cities';

const corridor = process.argv[2];
if (!corridor) {
  console.error('использование: scripts/osrm-extracts.ts <bbox коридора: minLon,minLat,maxLon,maxLat>');
  process.exit(2);
}

const nums = (box: string) => box.split(',').map(Number) as [number, number, number, number];
const [west, south, east, north] = nums(corridor);
const insideCorridor = (box: string) => {
  const [minLon, minLat, maxLon, maxLat] = nums(box);
  return minLon >= west && maxLon <= east && minLat >= south && maxLat <= north;
};

// Город внутри коридора выгружать второй раз незачем: он и так попадёт в граф,
// а лишний box только добавляет дубликаты узлов при merge.
const islands = CITY_SPAWNS.map((city) => roadBbox(city)).filter((box) => !insideCorridor(box));
console.log([corridor, ...islands].join('\n'));

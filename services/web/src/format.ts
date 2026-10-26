export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const rub = (value: number) => `${Math.round(value).toLocaleString('ru-RU')} ₽`;

export const km = (value: number) => `${value.toFixed(value < 10 ? 1 : 0)} км`;

/** 1 место / 2 места / 5 мест. */
export function plural(count: number, one: string, few: string, many: string) {
  const last = count % 10;
  const teens = count % 100;
  if (last === 1 && teens !== 11) return `${count} ${one}`;
  if (last >= 2 && last <= 4 && (teens < 12 || teens > 14)) return `${count} ${few}`;
  return `${count} ${many}`;
}

export function dateTime(iso: string) {
  const date = new Date(iso);
  return date.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function pointLabel(point: { name?: string; lat: number; lon: number }) {
  return point.name?.trim() || `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`;
}

/** Для input[type=datetime-local]: локальное время без сдвига часового пояса. */
export function toLocalInput(value: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

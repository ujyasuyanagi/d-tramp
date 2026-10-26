/** Детерминированный генератор (mulberry32): один и тот же seed → одна и та же толпа водителей. */
export interface Rng {
  float(): number;
  range(min: number, max: number): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
  weighted<T>(items: readonly { item: T; weight: number }[]): T;
}

export function createRng(seed = Date.now() % 2_147_483_647): Rng {
  let state = seed >>> 0;
  const float = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  return {
    float,
    range: (min, max) => min + float() * (max - min),
    int: (min, max) => Math.floor(min + float() * (max - min + 1)),
    pick: (items) => items[Math.floor(float() * items.length)]!,
    chance: (probability) => float() < probability,
    weighted: (entries) => {
      const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
      let ticket = float() * total;
      for (const entry of entries) {
        ticket -= entry.weight;
        if (ticket <= 0) return entry.item;
      }
      return entries[entries.length - 1]!.item;
    },
  };
}

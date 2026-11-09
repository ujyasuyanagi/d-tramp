#!/usr/bin/env node
// Render actual Vue component with fixtures; no HTTP server or browser required.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';

const cwd = resolve(new URL('..', import.meta.url).pathname);
const temp = await mkdtemp(`${tmpdir()}/dtramp-driver-check-`);
const entry = resolve(temp, 'entry.ts');
await writeFile(entry, `export { default as DriverPanel } from ${JSON.stringify(resolve(cwd, 'services/web/src/components/DriverPanel.vue'))};\nexport { default as MyPanel } from ${JSON.stringify(resolve(cwd, 'services/web/src/components/MyPanel.vue'))};\nexport { state } from ${JSON.stringify(resolve(cwd, 'services/web/src/store.ts'))};\nexport { ui } from ${JSON.stringify(resolve(cwd, 'services/web/src/ui.ts'))};\nexport { carPhoto } from ${JSON.stringify(resolve(cwd, 'services/web/src/carPhotos.ts'))};`);
globalThis.localStorage = { getItem: () => null };
try {
  const bundle = await build({ configFile: false, root: resolve(cwd, 'services/web'), plugins: [vue()], logLevel: 'error', build: { ssr: entry, write: false, rollupOptions: { output: { paths: { vue: import.meta.resolve('vue') } } } } });
  const file = resolve(temp, 'component.mjs');
  await writeFile(file, bundle.output.find(part => part.type === 'chunk' && part.isEntry).code.replace(/(["'])(vue(?:\/[^"']*)?)\1/g, (_, quote, specifier) => JSON.stringify(import.meta.resolve(specifier))));
  const { DriverPanel, MyPanel, state, ui, carPhoto } = await import(pathToFileURL(file).href);
  const render = () => renderToString(createSSRApp(DriverPanel));
  const driver = { id: 'driver-1', name: 'Алексей', car: { model: 'Toyota Camry', plate: 'А123АА777', regionLabel: 'Москва' }, rating: 4.8, lat: 55.75, lon: 37.61, status: 'FREE', pricePerKm: 25, freeRide: false, speedKmh: 40, distanceKm: 1.2 };
  assert.equal(await render(), '<!---->');
  console.log('✓ Panel hidden without selected vehicle');
  state.drivers = [driver]; ui.selectedDriver = driver;
  let html = await render();
  for (const value of ['Toyota Camry', 'Алексей', 'А123АА777', 'Москва', '4.8', '25', 'Свободна', 'Фото модели']) assert.ok(html.includes(value), value);
  assert.ok(html.includes('<img')); assert.ok(!html.includes('Фотография пока недоступна'));
  console.log('✓ Selected vehicle shows actual driver, car, price and model photograph');
  state.drivers = [{ ...driver, name: 'Алексей Обновлённый', status: 'BUSY', distanceKm: 2.4, rating: 4.9 }];
  html = await render();
  for (const value of ['Алексей Обновлённый', 'Занята', '2.4', '4.9']) assert.ok(html.includes(value), value);
  console.log('✓ Live updates refresh driver, status, rating and distance');
  state.drivers = [];
  html = await render();
  assert.ok(html.includes('Вне области карты')); assert.ok(html.includes('последние полученные данные'));
  console.log('✓ Missing vehicle is explicitly marked as last known information');
  const unknown = { ...driver, id: 'driver-2', name: 'Мария', car: { model: 'Ford Focus', plate: 'В456ВВ750' }, distanceKm: 8, freeRide: true };
  state.drivers = [unknown]; ui.selectedDriver = unknown;
  html = await render();
  assert.ok(html.includes('Мария')); assert.ok(html.includes('Ford Focus')); assert.ok(html.includes('Фотография пока недоступна')); assert.ok(html.includes('Бесплатно')); assert.ok(html.includes('за пределами радиуса')); assert.ok(!html.includes('<img'));
  console.log('✓ Switching cars updates details; unavailable model photo has a fallback');
  assert.ok(carPhoto('Geely Emgrand').includes('haval-emgrand'));
  assert.ok(carPhoto('Chery Tiggo 4').includes('cherry-tiggo-4'));
  assert.equal(carPhoto('Unknown model'), undefined);
  const source = await readFile(resolve(cwd, 'services/web/src/carPhotos.ts'), 'utf8');
  const mapped = [...source.matchAll(/assets\/([^']+\.jpg)/g)].map(match => match[1]);
  const assets = (await readdir(resolve(cwd, 'assets'))).filter(name => name.endsWith('.jpg'));
  assert.deepEqual(mapped.toSorted(), assets.toSorted());
  console.log(`✓ All ${assets.length} supplied car photographs mapped, including filename spelling differences`);
  ui.selectedDriver = null;
  assert.equal(await render(), '<!---->');
  console.log('✓ Closing clears panel');
  // A pending refund must remain actionable even behind six newer orders.
  const ride = { id: 'pending', plate: 'А123АА777', dest: { name: 'Москва', lat: 55.75, lon: 37.61 }, price: 125, status: 'CANCELLED', refundPending: true };
  state.rides = [...Array.from({ length: 6 }, (_, i) => ({ ...ride, id: `completed-${i}`, status: 'COMPLETED', refundPending: false })), ride];
  html = await renderToString(createSSRApp(MyPanel));
  assert.ok(html.includes('Повторить возврат'));
  assert.ok(html.includes('ожидает возврата'));
  console.log('✓ Pending refund stays visible and offers retry behind six newer orders');
  state.rides = [{ ...ride, refundPending: false }];
  html = await renderToString(createSSRApp(MyPanel));
  assert.ok(!html.includes('Повторить возврат'));
  assert.ok(!html.includes('ожидает возврата'));
  console.log('✓ Confirmed refund hides retry and pending label');
} finally {
  await rm(temp, { recursive: true, force: true });
  delete globalThis.localStorage;
}

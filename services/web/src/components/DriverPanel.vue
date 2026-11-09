<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { carPhoto } from '../carPhotos';
import { km, rub } from '../format';
import { state } from '../store';
import { ui } from '../ui';

const panel = ref<HTMLElement>();
const liveDriver = computed(() => state.drivers.find((driver) => driver.id === ui.selectedDriver?.id));
const driver = computed(() => liveDriver.value ?? ui.selectedDriver);
const photo = computed(() => driver.value ? carPhoto(driver.value.car.model) : undefined);
const photoFailed = ref(false);
const outsideRadius = computed(() => (driver.value?.distanceKm ?? 0) > state.radiusKm);
function close() {
  const marker = document.querySelector('.car-marker.selected')?.closest<HTMLElement>('.leaflet-marker-icon');
  ui.selectedDriver = null;
  void nextTick(() => marker?.focus({ preventScroll: true }));
}
function beforeEnter(element: Element) {
  (element as HTMLElement).inert = false;
  element.removeAttribute('aria-hidden');
}
function beforeLeave(element: Element) {
  (element as HTMLElement).inert = true;
  element.setAttribute('aria-hidden', 'true');
}
function onEscape(event: KeyboardEvent) {
  if (event.key === 'Escape' && !ui.authOpen && ui.selectedDriver) close();
}
watch(() => ui.selectedDriver?.id, async (id) => {
  if (!id) return;
  photoFailed.value = false;
  await nextTick();
  panel.value?.focus({ preventScroll: true });
});
watch(photo, () => { photoFailed.value = false; });
onMounted(() => document.addEventListener('keydown', onEscape));
onBeforeUnmount(() => document.removeEventListener('keydown', onEscape));
</script>

<template>
  <Transition name="driver-panel" @before-enter="beforeEnter" @before-leave="beforeLeave">
    <aside v-if="driver" ref="panel" class="driver-panel" tabindex="-1" aria-labelledby="driver-panel-title">
      <div :key="driver.id" class="driver-panel-details">
        <div class="driver-panel-heading"><div><span class="eyebrow">МАШИНА НА КАРТЕ</span><h2 id="driver-panel-title">{{ driver.car.model }}</h2></div><button class="icon-button close-button" aria-label="Закрыть информацию о водителе" @click="close">×</button></div>
        <figure class="driver-photo">
          <img v-if="photo && !photoFailed" :src="photo" :alt="`${driver.car.model} — фото модели`" @error="photoFailed = true" />
          <div v-else class="driver-photo-empty"><span aria-hidden="true">⌁</span><p>Фотография пока недоступна</p></div>
          <figcaption v-if="photo && !photoFailed">Фото модели</figcaption>
        </figure>
        <div class="driver-panel-body">
          <div class="vehicle-identity"><span class="plate">{{ driver.car.plate }}</span><span class="vehicle-status" :class="{ available: liveDriver && driver.status === 'FREE' }"><span class="status-dot" :class="{ free: liveDriver && driver.status === 'FREE', busy: liveDriver && driver.status === 'BUSY' }" />{{ !liveDriver ? 'Вне области карты' : driver.status === 'FREE' ? 'Свободна' : 'Занята' }}</span></div>
          <p v-if="driver.car.regionLabel" class="meta vehicle-region">{{ driver.car.regionLabel }}</p>
          <div class="selected-driver-info"><span class="avatar">{{ driver.name.charAt(0).toUpperCase() }}</span><div><span class="meta">Водитель</span><h3>{{ driver.name }}</h3></div><span class="driver-rating" aria-label="Рейтинг водителя">★ {{ driver.rating.toFixed(1) }}</span></div>
          <dl class="driver-facts"><div><dt>Тариф</dt><dd>{{ driver.freeRide ? 'Бесплатно' : `${rub(driver.pricePerKm)} / км` }}</dd></div><div v-if="driver.distanceKm !== undefined"><dt>До точки посадки</dt><dd>{{ km(driver.distanceKm) }}</dd></div></dl>
          <p v-if="!liveDriver" class="driver-panel-note">Машина больше не видна в текущей области карты. Показаны последние полученные данные.</p>
          <p v-else-if="outsideRadius" class="driver-panel-note">Машина за пределами радиуса поиска. Увеличьте радиус во вкладке «Машина», чтобы увидеть её в списке рядом.</p>
          <p v-else-if="driver.status === 'BUSY'" class="driver-panel-note">Водитель выполняет другую поездку.</p>
          <p v-else class="driver-panel-note">Вызвать машину можно во вкладке «Машина»: выберите её в списке «Машины рядом» или оставьте автоподбор по времени подачи.</p>
        </div>
      </div>
    </aside>
  </Transition>
</template>

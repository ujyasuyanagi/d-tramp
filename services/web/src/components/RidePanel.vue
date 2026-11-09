<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { actions, chosenDriver, driversInRadius, nearestFreeDriver, rideCancellable, rideDistanceKm, state } from '../store';
import type { VDriver } from '../api';
import { requestLogin } from '../ui';
import { km, pointLabel, rub } from '../format';

const now = ref(Date.now());
const ticker = setInterval(() => (now.value = Date.now()), 1_000);
onBeforeUnmount(() => clearInterval(ticker));

const active = computed(() => state.activeRide);
const minutesLeft = computed(() =>
  active.value ? Math.max(0, Math.ceil((new Date(active.value.finishAt).getTime() - now.value) / 60_000)) : 0,
);

const freeDrivers = computed(() => driversInRadius.value.filter((driver) => driver.status === 'FREE').slice(0, 5));
const featured = computed(() => chosenDriver.value ?? nearestFreeDriver.value);
const estimate = computed(() => {
  const driver = featured.value;
  if (!driver || !state.destination) return null;
  return { price: driver.freeRide ? 0 : Math.round(driver.pricePerKm * rideDistanceKm.value) };
});

function toggleDriver(driver: VDriver) {
  state.rideDriverId = state.rideDriverId === driver.id ? null : driver.id;
}

const trafficNote = computed(() => {
  const ride = active.value;
  if (!ride || ride.status !== 'ACCEPTED' || ride.trafficLevel === 'UNKNOWN') return '';
  if (ride.trafficLevel === 'FREE') return 'На подаче свободно.';
  const level = ride.trafficLevel === 'MODERATE' ? 'затруднено' : 'пробки';
  const delay = ride.pickupDelayMin > 0 ? ` · +${ride.pickupDelayMin} мин` : '';
  return `На подаче ${level}${delay}.`;
});
</script>

<template>
  <!-- Во время заказа маршрут зафиксирован: карточка поездки должна быть сверху,
       иначе «Я сел»/«Я вышел» уезжают под нижний край панели. -->
  <div v-if="!active" class="card">
    <h3>Куда едем</h3>
    <div class="field">
      <label>Откуда</label>
      <div class="row">
        <input data-field="rideFrom" :value="pointLabel(state.pickup)" readonly />
        <button
          type="button"
          class="shrink"
          data-pick="rideFrom"
          :class="{ primary: state.pickTarget === 'rideFrom' }"
          @click="state.pickTarget = state.pickTarget === 'rideFrom' ? 'none' : 'rideFrom'"
        >
          {{ state.pickTarget === 'rideFrom' ? 'Кликни на карте' : 'На карте' }}
        </button>
      </div>
    </div>
    <div class="field">
      <label>Куда</label>
      <div class="row">
        <input data-field="rideDest" :value="state.destination ? pointLabel(state.destination) : 'не выбрана'" readonly />
        <button
          type="button"
          class="shrink"
          data-pick="rideDest"
          :class="{ primary: state.pickTarget === 'rideDest' }"
          @click="state.pickTarget = state.pickTarget === 'rideDest' ? 'none' : 'rideDest'"
        >
          {{ state.pickTarget === 'rideDest' ? 'Кликни на карте' : 'На карте' }}
        </button>
      </div>
    </div>
    <div class="row">
      <button type="button" class="ghost shrink" @click="actions.locateMe()">Где я</button>
      <button v-if="state.destination" class="ghost danger shrink" @click="state.destination = null">Сброс</button>
    </div>
    <p v-if="state.destination" class="meta" style="margin: 6px 0 0">
      {{ km(rideDistanceKm) }}{{ state.preview ? (state.preview.byRoad ? ' по дорогам' : ' по прямой') : '' }}
    </p>
    <div class="field" style="margin-top: 10px">
      <label for="radius">Радиус поиска: {{ state.radiusKm }} км</label>
      <input id="radius" v-model.number="state.radiusKm" type="range" min="1" max="10" step="0.5" />
    </div>
  </div>

  <div v-if="active" class="card" style="border-color: var(--accent-dim)">
    <h3>Машина в пути</h3>
    <div class="driver-summary">
      <span class="plate">{{ active.plate }}</span>
      <div class="driver-summary-text">
        <div class="driver-summary-line">
          <strong>{{ active.driverName }}</strong>
        </div>
        <p class="meta">{{ active.carModel }}</p>
      </div>
    </div>
    <p class="meta" style="margin: 8px 0">
      {{ km(active.distanceKm) }} ·
      <template v-if="active.status === 'ACCEPTED'">приедет через ~{{ minutesLeft }} мин</template>
      <template v-else-if="active.status === 'DRIVER_ARRIVED'">машина у точки посадки, ждёт подтверждения</template>
      <template v-else-if="active.status === 'BOARDED'">в пути к точке назначения</template>
      <template v-else-if="active.status === 'ARRIVED'">приехали к точке назначения</template>
      <template v-else>{{ active.status === 'COMPLETED' ? 'поездка завершена' : 'заказ отменён' }}</template>
    </p>
    <p v-if="trafficNote" class="meta" style="margin: 0 0 6px">{{ trafficNote }}</p>
    <p v-if="active.trafficPreferred && active.status === 'ACCEPTED'" class="hint" style="margin: 0 0 8px">
      Ближайшая стояла в пробке — выбрана машина чуть дальше, но быстрее.
    </p>
    <div class="row">
      <div class="shrink" style="flex: 0 0 auto">
        <span class="meta">{{ active.price > 0 ? 'оплачено при вызове ' : 'акция: ' }}</span>
        <strong>{{ active.price > 0 ? rub(active.price) : 'бесплатно' }}</strong>
      </div>
      <button v-if="active.status === 'DRIVER_ARRIVED'" class="primary" :disabled="state.busy" @click="actions.boardRide(active.id)">
        Я сел
      </button>
      <button v-if="active.status === 'ARRIVED'" class="primary" :disabled="state.busy" @click="actions.exitRide(active.id)">
        Я вышел
      </button>
      <button v-if="rideCancellable(active)" class="danger" :disabled="state.busy" @click="actions.cancelRide(active.id)">
        Отменить заказ
      </button>
    </div>
  </div>

  <div v-else class="card">
    <h3>{{ chosenDriver ? 'Выбранная машина' : 'Ближайшая свободная' }}</h3>
    <template v-if="featured">
      <div class="driver-summary">
        <span class="plate">{{ featured.car.plate }}</span>
        <div class="driver-summary-text">
          <div class="driver-summary-line">
            <strong>{{ featured.name }}</strong>
            <span class="driver-summary-rating">{{ featured.rating.toFixed(1) }}★</span>
          </div>
          <p class="meta">{{ featured.car.model }}</p>
        </div>
      </div>
      <p class="meta" style="margin: 8px 0 10px">
        через {{ featured.distanceKm?.toFixed(2) }} км ·
        {{ featured.freeRide ? 'акция: бесплатная поездка' : `${featured.pricePerKm} ₽/км` }}
      </p>
      <p v-if="estimate" style="margin: 0 0 10px">
        <span class="meta">ориентировочно </span>
        <strong style="font-size: 18px">{{ rub(estimate.price) }}</strong>
        <span class="meta"> за {{ km(rideDistanceKm) }}</span>
      </p>
      <div class="row" style="flex-wrap: wrap">
        <button
          class="primary"
          style="flex: 1 1 170px"
          :disabled="!state.destination || state.busy"
          @click="state.user ? actions.requestRide() : requestLogin()"
        >
          {{ state.destination ? (chosenDriver ? 'Вызвать эту машину' : 'Вызвать машину') : 'Сначала выбери назначение' }}
        </button>
        <button v-if="chosenDriver" class="ghost shrink" style="flex: 0 0 auto" @click="state.rideDriverId = null">
          Ближайшая
        </button>
      </div>
      <p v-if="!state.user" class="hint" style="margin: 8px 0 0">Вызов машины — после входа.</p>
      <template v-else>
        <p v-if="!chosenDriver" class="hint" style="margin: 8px 0 0">При вызове учтём пробки: машина чуть дальше, но по свободной дороге, может приехать раньше.</p>
        <p class="hint" style="margin: 4px 0 0">Деньги спишутся сразу при вызове; отмена до посадки вернёт их на кошелёк.</p>
      </template>
    </template>
    <p v-else class="empty" style="margin: 0">
      Свободных машин рядом нет. Увеличь радиус или подожди — симуляция развозит занятых.
    </p>
  </div>

  <div class="card">
    <h3>Машины рядом</h3>
    <p v-if="!freeDrivers.length" class="meta" style="margin: 0">Все в работе.</p>
    <ul v-else class="driver-choice-list">
      <li v-for="driver in freeDrivers" :key="driver.id">
        <button
          type="button"
          class="driver-choice"
          :class="{ selected: chosenDriver?.id === driver.id }"
          :aria-pressed="chosenDriver?.id === driver.id"
          @click="toggleDriver(driver)"
        >
          <span class="driver-choice-main">
            <span class="status-dot free" aria-hidden="true"></span>
            <span class="plate">{{ driver.car.plate }}</span>
            <span class="meta"> · {{ driver.car.model }}</span>
          </span>
          <span class="driver-choice-facts meta">
            {{ driver.freeRide ? '0 ₽' : `${driver.pricePerKm} ₽/км` }} · {{ driver.distanceKm?.toFixed(1) }} км
          </span>
        </button>
      </li>
    </ul>
    <p v-if="freeDrivers.length" class="hint" style="margin: 8px 0 0">Выберите машину — цена и вызов пересчитаются для неё. Без выбора сервис подберёт лучшую по подаче.</p>
  </div>
</template>

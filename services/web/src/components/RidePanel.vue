<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { actions, driversInRadius, nearestFreeDriver, rideDistanceKm, rideEstimate, state } from '../store';
import { requestLogin } from '../ui';
import { km, pointLabel, rub } from '../format';

const now = ref(Date.now());
const ticker = setInterval(() => (now.value = Date.now()), 1_000);
onBeforeUnmount(() => clearInterval(ticker));

const active = computed(() => state.activeRide);
const minutesLeft = computed(() =>
  active.value ? Math.max(0, Math.ceil((new Date(active.value.finishAt).getTime() - now.value) / 60_000)) : 0,
);
const finished = computed(() => Boolean(active.value) && now.value >= new Date(active.value!.finishAt).getTime());

// когда поездка дошла до конца — перегружаем статусы, водитель снова становится свободен
watch(finished, (value) => {
  if (value) void actions.loadMine();
});

const freeDrivers = computed(() => driversInRadius.value.filter((driver) => driver.status === 'FREE').slice(0, 5));

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
  <div class="card">
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
    <p style="margin: 0 0 6px">
      <span class="plate">{{ active.plate }}</span>
      <strong style="margin-left: 8px">{{ active.driverName }}</strong>
      <span class="meta"> · {{ active.carModel }}</span>
    </p>
    <p class="meta" style="margin: 0 0 8px">
      {{ km(active.distanceKm) }} ·
      <template v-if="active.status === 'ACCEPTED'">
        приедет через ~{{ minutesLeft }} мин, в пути ещё ~{{ Math.max(0, minutesLeft - active.etaMin) }} мин
      </template>
      <template v-else>{{ active.status === 'COMPLETED' ? 'поездка завершена' : 'заказ отменён' }}</template>
    </p>
    <p v-if="trafficNote" class="meta" style="margin: 0 0 6px">{{ trafficNote }}</p>
    <p v-if="active.trafficPreferred && active.status === 'ACCEPTED'" class="hint" style="margin: 0 0 8px">
      Ближайшая стояла в пробке — выбрана машина чуть дальше, но быстрее.
    </p>
    <div class="row">
      <div class="shrink" style="flex: 0 0 auto">
        <span class="meta">к оплате </span><strong>{{ rub(active.price) }}</strong>
      </div>
      <button v-if="active.status === 'ACCEPTED'" class="danger" :disabled="state.busy" @click="actions.cancelRide(active.id)">
        Отменить заказ
      </button>
    </div>
  </div>

  <div v-else class="card">
    <h3>Ближайшая свободная</h3>
    <template v-if="nearestFreeDriver">
      <p style="margin: 0 0 6px">
        <span class="plate">{{ nearestFreeDriver.car.plate }}</span>
        <strong style="margin-left: 8px">{{ nearestFreeDriver.name }}</strong>
        <span class="meta"> · {{ nearestFreeDriver.car.model }} · {{ nearestFreeDriver.rating.toFixed(1) }}★</span>
      </p>
      <p class="meta" style="margin: 0 0 10px">
        через {{ nearestFreeDriver.distanceKm?.toFixed(2) }} км ·
        {{ nearestFreeDriver.freeRide ? 'акция: бесплатная поездка' : `${nearestFreeDriver.pricePerKm} ₽/км` }}
      </p>
      <p v-if="rideEstimate" style="margin: 0 0 10px">
        <span class="meta">ориентировочно </span>
        <strong style="font-size: 18px">{{ rub(rideEstimate.price) }}</strong>
        <span class="meta"> за {{ km(rideDistanceKm) }}</span>
      </p>
      <button
        class="primary"
        style="width: 100%"
        :disabled="!state.destination || state.busy"
        @click="state.user ? actions.requestRide() : requestLogin()"
      >
        {{ state.destination ? 'Вызвать машину' : 'Сначала выбери назначение' }}
      </button>
      <p v-if="!state.user" class="hint" style="margin: 8px 0 0">Вызов машины — после входа.</p>
      <p v-else class="hint" style="margin: 8px 0 0">
        При вызове учтём пробки: машина чуть дальше, но по свободной дороге, может приехать раньше.
      </p>
    </template>
    <p v-else class="empty" style="margin: 0">
      Свободных машин рядом нет. Увеличь радиус или подожди — симуляция развозит занятых.
    </p>
  </div>

  <div class="card">
    <h3>Машины рядом</h3>
    <p v-if="!freeDrivers.length" class="meta" style="margin: 0">Все в работе.</p>
    <ul class="list" style="margin: 0; padding: 0; list-style: none">
      <li v-for="driver in freeDrivers" :key="driver.id" class="row" style="justify-content: space-between">
        <span class="meta"><span class="status-dot free"></span> {{ driver.car.plate }} · {{ driver.car.model }}</span>
        <span class="meta shrink" style="flex: 0 0 auto">
          {{ driver.freeRide ? '0 ₽' : `${driver.pricePerKm} ₽/км` }} · {{ driver.distanceKm?.toFixed(1) }} км
        </span>
      </li>
    </ul>
  </div>
</template>

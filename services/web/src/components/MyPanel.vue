<script setup lang="ts">
import { computed, ref } from 'vue';
import { actions, rideActive, rideCancellable, state } from '../store';
import { dateTime, km, plural, pointLabel, rub } from '../format';

const bookedTrips = computed(() => state.bookings.filter((booking) => booking.status === 'CONFIRMED'));
const upcoming = computed(() => state.myTrips.filter((trip) => trip.status === 'SCHEDULED'));
const activeRides = computed(() => state.rides.filter(rideActive));
const visibleRides = computed(() => [
  ...state.rides.filter((ride) => ride.refundPending),
  ...state.rides.filter((ride) => !ride.refundPending).slice(0, 6),
]);

const rideLabels: Record<string, string> = {
  ACCEPTED: 'машина в пути',
  DRIVER_ARRIVED: 'машина у посадки',
  BOARDED: 'в пути',
  ARRIVED: 'приехали, ждём выхода',
  COMPLETED: 'завершён',
  CANCELLED: 'отменён',
};

const customTopUp = ref('');

async function topUp(amount: number) {
  if (await actions.topUp(amount)) customTopUp.value = '';
}
</script>

<template>
  <div class="card">
    <h3>Мои брони</h3>
    <p v-if="!bookedTrips.length" class="meta" style="margin: 0">Пока пусто — забронируй место во вкладке «Попутки».</p>
    <div v-for="booking in bookedTrips" :key="booking.id" class="card" style="margin-top: 8px">
      <h3 v-if="booking.trip">{{ pointLabel(booking.trip.from) }} → {{ pointLabel(booking.trip.to) }}</h3>
      <p class="meta" style="margin: 0 0 6px">
        {{ booking.trip ? dateTime(booking.trip.dateTime) : '' }} ·
        {{ plural(booking.seats, 'место', 'места', 'мест') }} ·
        {{ rub(booking.priceTotal) }}
      </p>
      <button class="danger" :disabled="state.busy" @click="actions.cancelBooking(booking.id)">Отменить бронь</button>
    </div>
  </div>

  <div class="card">
    <h3>Мои поездки <span class="meta">(как водитель)</span></h3>
    <p v-if="!upcoming.length" class="meta" style="margin: 0">Опубликованных поездок нет.</p>
    <div v-for="trip in upcoming" :key="trip.id" class="card" style="margin-top: 8px">
      <h3>{{ pointLabel(trip.from) }} → {{ pointLabel(trip.to) }}</h3>
      <p class="meta" style="margin: 0 0 6px">
        {{ dateTime(trip.dateTime) }} · занято {{ trip.seatsTotal - trip.seatsAvailable }} из {{ trip.seatsTotal }} ·
        {{ rub(trip.price) }}<template v-if="trip.distanceKm"> · {{ km(trip.distanceKm) }}</template>
      </p>
      <button class="danger" :disabled="state.busy" @click="actions.cancelTrip(trip.id)">Снять с публикации</button>
    </div>
  </div>

  <div class="card">
    <h3>Кошелёк</h3>
    <p style="margin: 0 0 8px">
      <span class="meta">баланс </span><strong style="font-size: 18px" :style="state.user && state.user.balance < 0 ? { color: 'var(--danger, #c0392b)' } : {}">{{ rub(state.user?.balance ?? 0) }}</strong>
    </p>
    <p class="meta" style="margin: 0 0 10px">Цена заказа машины списывается отсюда в момент вызова (отмена до посадки возвращает её); пополнение — имитация, как и водители.</p>
    <div class="row wallet-row">
      <button v-for="amount in [500, 1000, 3000]" :key="amount" class="ghost shrink" :disabled="state.busy" @click="topUp(amount)">
        +{{ amount }}
      </button>
      <input v-model="customTopUp" type="number" min="1" max="50000" placeholder="своя сумма" aria-label="Своя сумма пополнения" />
      <button
        class="primary shrink"
        style="flex: 0 0 auto"
        :disabled="state.busy || !(Number(customTopUp) >= 1)"
        @click="topUp(Math.min(50_000, Number(customTopUp)))"
      >
        Пополнить
      </button>
    </div>
  </div>

  <div class="card">
    <h3>Заказы машины</h3>
    <p v-if="!state.rides.length" class="meta" style="margin: 0">Вызовов ещё не было.</p>
    <div v-for="ride in visibleRides" :key="ride.id" class="row" style="justify-content: space-between; padding: 6px 0">
      <span class="meta">
        <span class="status-dot" :class="rideActive(ride) ? 'free' : ride.status === 'CANCELLED' ? 'cancelled' : ''"></span>
        <span class="plate">{{ ride.plate }}</span> {{ pointLabel(ride.dest) }} ·
        {{ ride.refundPending ? `ожидает возврата ${rub(ride.price)}` : ride.status === 'CANCELLED' && ride.price > 0 ? `возврат ${rub(ride.price)}` : rub(ride.price) }}
      </span>
      <button v-if="rideCancellable(ride) || ride.refundPending" :disabled="state.busy" class="shrink danger" style="flex: 0 0 auto" @click="actions.cancelRide(ride.id)">
        {{ ride.refundPending ? 'Повторить возврат' : 'Отменить' }}
      </button>
      <span v-else class="meta shrink" style="flex: 0 0 auto">{{ rideLabels[ride.status] ?? ride.status }}</span>
    </div>
    <p v-if="activeRides.length" class="hint" style="margin: 8px 0 0">Активных заказов: {{ activeRides.length }}.</p>
  </div>

  <button class="ghost" :disabled="state.busy" @click="actions.loadMine()">Обновить</button>
</template>

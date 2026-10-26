<script setup lang="ts">
import { computed } from 'vue';
import { actions, state } from '../store';
import { dateTime, km, plural, pointLabel, rub } from '../format';

const bookedTrips = computed(() => state.bookings.filter((booking) => booking.status === 'CONFIRMED'));
const upcoming = computed(() => state.myTrips.filter((trip) => trip.status === 'SCHEDULED'));
const activeRides = computed(() => state.rides.filter((ride) => ride.status === 'ACCEPTED'));
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
    <h3>Заказы машины</h3>
    <p v-if="!state.rides.length" class="meta" style="margin: 0">Вызовов ещё не было.</p>
    <div v-for="ride in state.rides.slice(0, 6)" :key="ride.id" class="row" style="justify-content: space-between; padding: 6px 0">
      <span class="meta">
        <span class="status-dot" :class="ride.status === 'ACCEPTED' ? 'free' : ride.status === 'CANCELLED' ? 'cancelled' : ''"></span>
        <span class="plate">{{ ride.plate }}</span> {{ pointLabel(ride.dest) }} · {{ rub(ride.price) }}
      </span>
      <button v-if="ride.status === 'ACCEPTED'" class="shrink danger" style="flex: 0 0 auto" @click="actions.cancelRide(ride.id)">
        Отменить
      </button>
      <span v-else class="meta shrink" style="flex: 0 0 auto">
        {{ ride.status === 'COMPLETED' ? 'завершён' : 'отменён' }}
      </span>
    </div>
    <p v-if="activeRides.length" class="hint" style="margin: 8px 0 0">Активных заказов: {{ activeRides.length }}.</p>
  </div>

  <button class="ghost" :disabled="state.busy" @click="actions.loadMine()">Обновить</button>
</template>

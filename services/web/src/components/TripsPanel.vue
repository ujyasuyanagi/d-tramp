<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { actions, state } from '../store';
import { requestLogin, ui } from '../ui';
import { dateTime, km, pointLabel, rub, toLocalInput } from '../format';

const showCreate = ref(false);
const seatsToBook = ref(1);
const form = ref({
  dateTime: toLocalInput(new Date(Date.now() + 2 * 3_600_000)),
  seats: 3,
  price: 800,
  comment: '',
});

onMounted(() => {
  void actions.searchTrips();
});

async function book(tripId: string) {
  if (!state.user) { requestLogin(tripId); return; }
  if (await actions.bookTrip(tripId, seatsToBook.value)) {
    seatsToBook.value = 1;
    ui.bookingIntent = null;
  }
}

async function create() {
  if (await actions.createTrip(form.value)) showCreate.value = false;
}
</script>

<template>
  <form class="search-card" @submit.prevent="actions.searchTrips()">
    <div class="route-fields">
      <div class="field route-field"><span class="route-dot" aria-hidden="true" /><div><label for="from">Откуда</label><input id="from" v-model="state.search.from" placeholder="Город отправления" autocomplete="off" /></div></div>
      <div class="field route-field"><span class="route-dot destination-dot" aria-hidden="true" /><div><label for="to">Куда</label><input id="to" v-model="state.search.to" placeholder="Город назначения" autocomplete="off" /></div></div>
      <button type="button" class="swap-button icon-button" aria-label="Поменять города местами" @click="[state.search.from, state.search.to] = [state.search.to, state.search.from]">↕</button>
    </div>
    <div class="row search-options">
      <div class="field"><label for="date">Дата поездки</label><input id="date" v-model="state.search.date" type="date" /></div>
      <div class="field seats-field"><label for="seats">Пассажиры</label><input id="seats" v-model.number="state.search.seats" type="number" min="1" max="8" /></div>
    </div>
    <button class="primary search-submit" type="submit" :disabled="state.busy"><span>{{ state.busy ? 'Ищем попутку…' : 'Найти попутку' }}</span><span aria-hidden="true">↗</span></button>
  </form>

  <div class="results-heading"><h2>Вам по пути</h2><span class="results-count">{{ state.trips?.length ?? '—' }} поездок</span></div>
  <div v-if="state.busy && state.trips === null" class="loading-cards" role="status"><div class="skeleton" /><div class="skeleton" /><span class="hint">Ищем поездки…</span></div>
  <div class="list trip-list">
    <div v-if="state.trips !== null && !state.trips.length" class="empty"><span class="empty-icon" aria-hidden="true">↗</span><h3>Ваша попутка ещё впереди</h3><p>Попробуйте другую дату или соседний город.</p></div>
    <div v-else-if="state.trips === null && !state.busy" class="empty"><h3>Не удалось загрузить поездки</h3><p>Проверьте соединение и попробуйте ещё раз.</p><button @click="actions.searchTrips()">Повторить</button></div>
    <article v-for="trip in state.trips" :key="trip.id" class="card trip-card" :class="{ 'selected-trip': ui.bookingIntent === trip.id }">
      <div class="trip-topline"><span class="trip-date">{{ dateTime(trip.dateTime) }}</span><strong class="trip-price">{{ rub(trip.price) }}<small>за место</small></strong></div>
      <div class="trip-route"><div><span class="route-dot" aria-hidden="true" /><h3>{{ pointLabel(trip.from) }}</h3></div><div><span class="route-dot destination-dot" aria-hidden="true" /><h3>{{ pointLabel(trip.to) }}</h3></div></div>
      <p class="meta trip-distance">{{ trip.distanceKm ? km(trip.distanceKm) + ' · ' : '' }}Свободно {{ trip.seatsAvailable }} из {{ trip.seatsTotal }} мест</p>
      <div v-if="trip.driver" class="driver-info"><span class="avatar">{{ trip.driver.name.charAt(0).toUpperCase() }}</span><span>{{ trip.driver.name }}</span><span class="driver-rating">★ {{ trip.driver.rating.toFixed(1) }}</span></div>
      <p v-if="trip.comment" class="trip-comment">{{ trip.comment }}</p>
      <p v-if="ui.bookingIntent === trip.id && state.user" class="hint">Вы выбрали эту поездку. Подтвердите бронирование.</p>
      <div class="row booking-row"><label class="booking-seats">Мест<input v-model.number="seatsToBook" aria-label="Количество мест для бронирования" type="number" min="1" :max="Math.max(1, trip.seatsAvailable)" /></label><button class="book-button" :disabled="trip.seatsAvailable < seatsToBook || state.busy" @click="book(trip.id)">{{ trip.seatsAvailable ? 'Забронировать' : 'Мест нет' }} <span aria-hidden="true">↗</span></button></div>
    </article>
  </div>

  <div class="card">
    <button class="ghost" style="width: 100%; text-align: left" @click="state.user ? (showCreate = !showCreate) : requestLogin()">
      {{ showCreate ? '− Свернуть' : '+ Опубликовать поездку' }}
    </button>

    <form v-if="showCreate" class="create-form" style="margin-top: 12px" @submit.prevent="create">
      <div class="field">
        <label>Откуда</label>
        <div class="row">
          <input :value="pointLabel(state.pickup)" readonly />
          <button type="button" class="shrink" :class="{ primary: state.pickTarget === 'tripFrom' }" @click="state.pickTarget = state.pickTarget === 'tripFrom' ? 'none' : 'tripFrom'">
            {{ state.pickTarget === 'tripFrom' ? 'Кликни на карте' : 'На карте' }}
          </button>
        </div>
      </div>
      <div class="field">
        <label>Куда</label>
        <div class="row">
          <input :value="state.destination ? pointLabel(state.destination) : 'не выбрана'" readonly />
          <button type="button" class="shrink" :class="{ primary: state.pickTarget === 'tripTo' }" @click="state.pickTarget = state.pickTarget === 'tripTo' ? 'none' : 'tripTo'">
            {{ state.pickTarget === 'tripTo' ? 'Кликни на карте' : 'На карте' }}
          </button>
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label for="when">Когда</label>
          <input id="when" v-model="form.dateTime" type="datetime-local" required />
        </div>
        <div class="field" style="max-width: 80px">
          <label for="cnt">Мест</label>
          <input id="cnt" v-model.number="form.seats" type="number" min="1" max="8" />
        </div>
        <div class="field" style="max-width: 110px">
          <label for="cost">Цена, ₽</label>
          <input id="cost" v-model.number="form.price" type="number" min="0" step="50" />
        </div>
      </div>
      <div class="field">
        <label for="comment">Комментарий</label>
        <input id="comment" v-model="form.comment" maxlength="300" placeholder="Например: еду по Минскому, есть детское кресло" />
      </div>
      <button class="primary" type="submit" :disabled="state.busy">Опубликовать</button>
    </form>
    <p v-if="!state.user" class="hint" style="margin: 10px 0 0">Публикация поездок — после входа водителем или пассажиром.</p>
  </div>
</template>

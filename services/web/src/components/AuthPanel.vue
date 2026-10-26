<script setup lang="ts">
import { ref } from 'vue';
import { actions, state } from '../store';

const mode = ref<'login' | 'register'>('login');
const email = ref('');
const password = ref('');
const name = ref('');
const phone = ref('');
const role = ref<'DRIVER' | 'PASSENGER'>('PASSENGER');

async function submit() {
  const done =
    mode.value === 'login'
      ? await actions.login(email.value, password.value)
      : await actions.register({
          email: email.value,
          password: password.value,
          name: name.value,
          role: role.value,
          phone: phone.value || undefined,
        });
  if (done) {
    password.value = '';
    phone.value = '';
  }
}
</script>

<template>
  <form class="card" @submit.prevent="submit">
    <div class="row" style="margin-bottom: 10px">
      <button type="button" :class="{ primary: mode === 'login' }" @click="mode = 'login'">Вход</button>
      <button type="button" :class="{ primary: mode === 'register' }" @click="mode = 'register'">Регистрация</button>
    </div>

    <div class="field">
      <label for="email">Email</label>
      <input id="email" v-model="email" type="email" required autocomplete="email" placeholder="you@dtramp.test" />
    </div>
    <div class="field">
      <label for="password">Пароль</label>
      <input id="password" v-model="password" type="password" required minlength="6" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" placeholder="минимум 6 символов" />
    </div>

    <template v-if="mode === 'register'">
      <div class="field">
        <label for="name">Имя</label>
        <input id="name" v-model="name" required minlength="2" placeholder="Как вас видят пассажиры" />
      </div>
      <div class="row">
        <div class="field">
          <label for="role">Кем едете</label>
          <select id="role" v-model="role">
            <option value="PASSENGER">Пассажир</option>
            <option value="DRIVER">Водитель</option>
          </select>
        </div>
        <div class="field">
          <label for="phone">Телефон</label>
          <input id="phone" v-model="phone" placeholder="+7 900 ..." />
        </div>
      </div>
    </template>

    <button class="primary" type="submit" style="width: 100%" :disabled="state.busy">
      {{ mode === 'login' ? 'Войти' : 'Создать аккаунт' }}
    </button>
    <p class="hint" style="margin: 10px 0 0">
      Гостем можно искать попутки и смотреть машины на карте. Брони и вызов машины — после входа.
    </p>
  </form>
</template>

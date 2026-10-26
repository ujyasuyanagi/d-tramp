<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { actions, state, type Tab } from './store';
import { requestLogin, ui } from './ui';
import DriverPanel from './components/DriverPanel.vue';
import AuthPanel from './components/AuthPanel.vue';
import MapView from './components/MapView.vue';
import MyPanel from './components/MyPanel.vue';
import RidePanel from './components/RidePanel.vue';
import TripsPanel from './components/TripsPanel.vue';

const theme = ref(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
let manualTheme = false;
try { manualTheme = !!localStorage.getItem('dtramp.theme'); } catch {}
function applyTheme(value: string) {
  theme.value = value;
  document.documentElement.dataset.theme = value;
}
function toggleTheme() {
  applyTheme(theme.value === 'dark' ? 'light' : 'dark');
  manualTheme = true;
  try { localStorage.setItem('dtramp.theme', theme.value); } catch {}
}
function followSystem(event: MediaQueryListEvent) {
  if (!manualTheme) applyTheme(event.matches ? 'dark' : 'light');
}
const sheet = ref(1);
const modal = ref<HTMLDialogElement>();
const heading = computed(() => state.tab === 'trips' ? 'Вместе по пути' : state.tab === 'ride' ? 'Куда поедем?' : 'Ваши поездки');
const subtitle = computed(() => state.tab === 'trips' ? 'Найдите попутку. Разделите дорогу.' : state.tab === 'ride' ? 'Машина рядом, маршрут — ваш.' : 'Планы, брони и любимые маршруты.');
let suppressSheetClick = false;
let dragStart = 0;
let dragPointer: number | null = null;
function startDrag(event: PointerEvent) {
  suppressSheetClick = false;
  dragStart = event.clientY;
  dragPointer = event.pointerId;
  (event.target as HTMLElement).setPointerCapture(event.pointerId);
}
function endDrag(event: PointerEvent) {
  if (dragPointer !== event.pointerId) return;
  dragPointer = null;
  const delta = event.clientY - dragStart;
  if (Math.abs(delta) > 30) {
    suppressSheetClick = true;
    sheet.value = Math.max(0, Math.min(2, sheet.value + (delta < 0 ? 1 : -1)));
  }
}
function cycleSheet() {
  if (!suppressSheetClick) sheet.value = (sheet.value + 1) % 3;
  suppressSheetClick = false;
}
async function open(tab: Tab) {
  state.tab = tab;
  if (sheet.value === 0) sheet.value = 1;
  if (tab === 'mine') await actions.loadMine();
}
watch(() => state.user, (user) => {
  if (!user && state.tab === 'mine') state.tab = 'trips';
  if (user) ui.authOpen = false;
});
watch(() => state.pickTarget, (target) => {
  if (target !== 'none') { sheet.value = 0; ui.selectedDriver = null; }
  else sheet.value = 1;
});
watch(() => ui.authOpen, async (isOpen) => {
  if (isOpen) { await nextTick(); modal.value?.showModal(); }
  else modal.value?.close();
});
onMounted(async () => {
  systemTheme.addEventListener('change', followSystem);
  await actions.bootstrap();
  if (state.user) await actions.loadMine();
});
onBeforeUnmount(() => systemTheme.removeEventListener('change', followSystem));
</script>

<template>
  <div class="shell">
    <a class="skip-link" href="#main-panel">Перейти к поиску</a>
    <header class="topbar">
      <a class="brand" href="#" aria-label="D-Tramp — на главную" @click.prevent="open('trips')">
        <span class="brand-mark" aria-hidden="true">D<span>↗</span></span>
        <span class="brand-copy"><strong>D-Tramp<span class="brand-period">.</span></strong><span class="brand-tagline">Попутчик найдётся — дорога начнётся</span></span>
      </a>
      <div class="header-caption">Меньше машин. Больше встреч.</div>
      <div class="header-actions">
        <button class="theme-toggle icon-button" :aria-label="theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'" @click="toggleTheme">{{ theme === 'dark' ? '☀' : '☾' }}</button>
        <template v-if="state.user">
          <button class="account-button" @click="open('mine')"><span class="avatar">{{ state.user.name.charAt(0).toUpperCase() }}</span><span class="account-name">{{ state.user.name }}</span></button>
          <button class="ghost logout-button" @click="actions.logout()">Выйти</button>
        </template>
        <button v-else class="login-button" @click="requestLogin()">Войти <span aria-hidden="true">↗</span></button>
      </div>
    </header>

    <main class="layout">
      <MapView />
      <DriverPanel />
      <div v-if="state.pickTarget !== 'none'" class="pick-instruction" role="status">Выберите точку на карте <button class="ghost" @click="state.pickTarget = 'none'">Отмена</button></div>
      <section id="main-panel" class="panel" :class="`sheet-${sheet}`" aria-label="Поездки" tabindex="-1">
        <div class="sheet-handle" @pointerdown="startDrag" @pointerup="endDrag" @pointercancel="dragPointer = null">
          <button aria-label="Изменить высоту панели" @click="cycleSheet"><span /></button>
        </div>
        <div class="panel-fixed">
          <nav class="tabs" aria-label="Режим поездки">
            <button :class="{ active: state.tab === 'trips' }" :aria-pressed="state.tab === 'trips'" @click="open('trips')"><span aria-hidden="true">↗</span> Попутки</button>
            <button :class="{ active: state.tab === 'ride' }" :aria-pressed="state.tab === 'ride'" @click="open('ride')"><span aria-hidden="true">⌁</span> Машина</button>
            <button v-if="state.user" :class="{ active: state.tab === 'mine' }" :aria-pressed="state.tab === 'mine'" @click="open('mine')">Мои</button>
          </nav>
          <div class="panel-heading"><span class="eyebrow">D-TRAMP / {{ state.tab === 'trips' ? 'ПОПУТКИ' : state.tab === 'ride' ? 'МАШИНА РЯДОМ' : 'ЛИЧНОЕ' }}</span><h1>{{ heading }}</h1><p>{{ subtitle }}</p></div>
        </div>
        <div class="panel-content" :aria-busy="state.busy" @focusin="sheet === 0 && (sheet = 1)">
          <TripsPanel v-if="state.tab === 'trips'" />
          <RidePanel v-else-if="state.tab === 'ride'" />
          <MyPanel v-else-if="state.user" />
          <div class="panel-footer"><span class="footer-symbol" aria-hidden="true">↗</span> Хорошая компания начинается с дороги</div>
        </div>
      </section>
      <button class="locate-button icon-button map-hint" aria-label="Моё местоположение" data-hint="Моё местоположение" @click="actions.locateMe()">◎</button>
      <div class="map-signature" aria-hidden="true">ВАШ МАРШРУТ.<br /><strong>ВАША КОМПАНИЯ.</strong></div>
    </main>

    <dialog ref="modal" class="auth-dialog" aria-labelledby="auth-title" @close="ui.authOpen = false" @cancel="ui.authOpen = false" @click="($event.target === modal) && (ui.authOpen = false)">
      <div class="auth-dialog-content"><button class="close-button icon-button" aria-label="Закрыть вход" @click="ui.authOpen = false">×</button><span class="eyebrow">РАДЫ ВАС ВИДЕТЬ</span><h2 id="auth-title">Дальше — вместе.</h2><p class="meta">{{ ui.bookingIntent ? 'Войдите, чтобы продолжить бронирование выбранной поездки.' : 'Войдите, чтобы бронировать и публиковать поездки.' }}</p><AuthPanel /></div>
    </dialog>
    <div class="toast-stack" aria-live="polite" aria-atomic="true"><div v-if="state.error" class="banner error" role="alert">{{ state.error }}</div><div v-if="state.notice" class="banner notice">{{ state.notice }}</div></div>
  </div>
</template>

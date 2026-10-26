import { reactive } from 'vue';
import type { VDriver } from './api';

export const ui = reactive({
  authOpen: false,
  selectedDriver: null as VDriver | null,
  bookingIntent: null as string | null,
});

export function requestLogin(tripId?: string) {
  ui.bookingIntent = tripId ?? null;
  ui.authOpen = true;
}

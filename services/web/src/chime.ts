let context: AudioContext | undefined;

/**
 * «Дзынь» на Web Audio: два синусоидальных звука с затуханием — без аудиофайлов
 * и внешних зависимостей. До первого пользовательского клика браузер молча
 * блокирует звук — поездку вызывают кнопкой, так что к прибытию контекст разблокирован.
 */
export function playChime() {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    context ??= new Ctor();
    if (context.state === 'suspended') void context.resume();
    const start = context.currentTime;
    [880, 1174.66].forEach((frequency, index) => {
      const oscillator = context!.createOscillator();
      const gain = context!.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      const at = start + index * 0.18;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.linearRampToValueAtTime(0.25, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.7);
      oscillator.connect(gain).connect(context!.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.75);
    });
  } catch {
    // звук не критичен для поездки
  }
}

// Photographs show the vehicle model, not a verified photo of a particular driver's car.
// Two source filenames differ from the manufacturer/model spelling; keep the mapping explicit.
const modelPhotos: Record<string, string> = {
  'lada vesta': new URL('../../../assets/lada-vesta.jpg', import.meta.url).href,
  'lada granta': new URL('../../../assets/lada-granta.jpg', import.meta.url).href,
  'kia rio': new URL('../../../assets/kia-rio.jpg', import.meta.url).href,
  'hyundai solaris': new URL('../../../assets/hyundai-solaris.jpg', import.meta.url).href,
  'vw polo': new URL('../../../assets/vw-polo.jpg', import.meta.url).href,
  'skoda rapid': new URL('../../../assets/skoda-rapid.jpg', import.meta.url).href,
  'renault logan': new URL('../../../assets/renault-logan.jpg', import.meta.url).href,
  'nissan almera': new URL('../../../assets/nissan-almera.jpg', import.meta.url).href,
  'toyota camry': new URL('../../../assets/toyota-camry.jpg', import.meta.url).href,
  'haval jolion': new URL('../../../assets/haval-jolion.jpg', import.meta.url).href,
  'geely emgrand': new URL('../../../assets/haval-emgrand.jpg', import.meta.url).href,
  'chery tiggo 4': new URL('../../../assets/cherry-tiggo-4.jpg', import.meta.url).href,
  'changan cs35': new URL('../../../assets/changan-cs35.jpg', import.meta.url).href,
};

export function carPhoto(model: string): string | undefined {
  return modelPhotos[model.trim().toLowerCase()];
}

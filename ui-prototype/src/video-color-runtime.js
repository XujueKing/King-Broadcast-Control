const clampByte = (value) => Math.max(0, Math.min(255, Math.round(value)));

const rgbToHsv = (r, g, b) => {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (max === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return { hue, saturation: max === 0 ? 0 : delta / max, brightness: max };
};

const hueFamily = ({ hue, saturation, brightness }) => {
  if (brightness < 0.08 || saturation < 0.18) return "neutral";
  if (hue < 20 || hue >= 345) return "red";
  if (hue < 45) return "orange";
  if (hue < 70) return "yellow";
  if (hue < 165) return "green";
  if (hue < 195) return "cyan";
  if (hue < 255) return "blue";
  if (hue < 330) return "purple";
  return "red";
};

export const analyzeVideoPixels = (pixels) => {
  let red = 0;
  let green = 0;
  let blue = 0;
  let totalWeight = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    if (pixels[index + 3] < 128) continue;
    const r = pixels[index];
    const g = pixels[index + 1];
    const b = pixels[index + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 8) continue;
    const saturation = max === 0 ? 0 : (max - min) / max;
    const weight = 0.2 + saturation * 1.8;
    red += r * weight;
    green += g * weight;
    blue += b * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) return null;
  const rgb = {
    r: clampByte(red / totalWeight),
    g: clampByte(green / totalWeight),
    b: clampByte(blue / totalWeight),
  };
  const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
  return { ...rgb, ...hsv, family: hueFamily(hsv) };
};

export const sampleVideoColor = (video, canvas) => {
  if (!video || !canvas || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) return null;
  canvas.width = 24;
  canvas.height = 14;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return analyzeVideoPixels(context.getImageData(0, 0, canvas.width, canvas.height).data);
};

export const lightingPresetForVideoColor = (sample, mappings, { allowUnmapped = false } = {}) => {
  const preferred = ({
    red: 2,
    orange: 2,
    yellow: 2,
    green: 0,
    cyan: 0,
    blue: 1,
    purple: 1,
  })[sample?.family];
  return Number.isInteger(preferred) && (allowUnmapped || mappings?.[preferred]) ? preferred : null;
};

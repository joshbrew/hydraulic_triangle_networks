
export async function loadImageElement(url) {
  return await new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to load DEM image.'));
    image.src = url;
  });
}

export async function rasterizeHeightfieldImage(sourceImage, { minHeight = 0, maxHeight = 1, alphaMeansInvalid = true } = {}) {
  const width = sourceImage.naturalWidth || sourceImage.width;
  const height = sourceImage.naturalHeight || sourceImage.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to acquire a 2D canvas context.');
  ctx.drawImage(sourceImage, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  const rgba = imageData.data;
  const values = new Float32Array(width * height);
  const mask = new Uint8Array(width * height);

  for (let i = 0, p = 0; i < values.length; i++, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    const a = rgba[p + 3];
    const intensity = (r + g + b) / (3 * 255);
    values[i] = minHeight + intensity * (maxHeight - minHeight);
    mask[i] = alphaMeansInvalid && a === 0 ? 0 : 1;
  }

  return { width, height, values, mask };
}

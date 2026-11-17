export async function apiWithMetadata<T>(path: string, body?: unknown, method: 'POST' | 'DELETE' | 'PUT' = 'POST', headers: Record<string, string> = {}): Promise<{ data: T; etag: string | null }> {
  const response = await fetch(`/api${path}`, body === undefined ? undefined : {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    const detail = result?.detail;
    throw new Error(typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map((e: { msg: string }) => e.msg).join('；') : `请求失败 (${response.status})`);
  }
  return { data: await response.json(), etag: response.headers.get('ETag') };
}

export async function api<T>(path: string, body?: unknown, method: 'POST' | 'DELETE' | 'PUT' = 'POST'): Promise<T> {
  return (await apiWithMetadata<T>(path, body, method)).data;
}

export function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法读取图层图像'));
    image.src = source;
  });
}

export function blankImage(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas.toDataURL('image/png');
}

export const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export async function api(path, { method = 'GET', body, headers } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Error de servidor'), { status: res.status, data });
  return data;
}

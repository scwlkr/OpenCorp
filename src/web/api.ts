export class WebApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal,
  });
  const value = await response.json() as T & { error?: string | { message?: string }; message?: string };
  if (!response.ok) throw new WebApiError(typeof value.error === 'string' ? value.error : value.error?.message || value.message || `Request failed (${response.status})`, response.status);
  return value;
}

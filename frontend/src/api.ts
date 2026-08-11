export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: options.body
      ? { "Content-Type": "application/json", ...(options.headers ?? {}) }
      : options.headers,
  })
  const value = (await response.json().catch(() => ({}))) as { error?: string } & T
  if (!response.ok) throw new ApiError(value.error || `${response.status} ${response.statusText}`, response.status)
  return value
}

export const postJSON = <T>(path: string, value: unknown = {}): Promise<T> =>
  api<T>(path, { method: "POST", body: JSON.stringify(value) })

export const putJSON = <T>(path: string, value: unknown): Promise<T> =>
  api<T>(path, { method: "PUT", body: JSON.stringify(value) })

export const patchJSON = <T>(path: string, value: unknown): Promise<T> =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(value) })

export const del = <T>(path: string, value?: unknown): Promise<T> =>
  api<T>(path, {
    method: "DELETE",
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  })

export async function clientApi<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  const timeoutSignal = AbortSignal.timeout(15_000);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;

  try {
    response = await fetch(`/api${path}`, {
      ...init,
      signal,
      headers: { "Content-Type": "application/json", ...init?.headers }
    });
  } catch {
    throw new Error("서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.");
  }

  if (response.status === 204) return undefined as T;

  let body: { message?: string };
  try {
    body = await response.json() as { message?: string };
  } catch {
    if (response.ok) {
      throw new Error("서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.");
    }
    body = {};
  }
  if (!response.ok) throw new Error(body.message ?? "요청을 처리하지 못했습니다.");
  return body as T;
}

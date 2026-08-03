import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { serverApiMock } = vi.hoisted(() => ({ serverApiMock: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("./server-api", () => ({
  ServerApiError: class ServerApiError extends Error {
    constructor(readonly status: number) {
      super(`API_${status}`);
    }
  },
  serverApi: serverApiMock
}));

import { ServerApiError } from "./server-api";
import { currentUser } from "./current-user";

describe("header session", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    serverApiMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("recovers the signed-in user when the backend becomes ready", async () => {
    serverApiMock
      .mockRejectedValueOnce(new ServerApiError(503))
      .mockResolvedValueOnce({ user: { displayName: "민서 엄마" } });

    const result = currentUser();
    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toEqual({ displayName: "민서 엄마" });
    expect(serverApiMock).toHaveBeenCalledTimes(2);
  });

  it("treats an unauthorized response as signed out without retrying", async () => {
    serverApiMock.mockRejectedValueOnce(new ServerApiError(401));

    await expect(currentUser()).resolves.toBeNull();
    expect(serverApiMock).toHaveBeenCalledTimes(1);
  });

  it("does not let a header lookup outage block public pages", async () => {
    serverApiMock.mockRejectedValue(new ServerApiError(503));

    const result = expect(currentUser()).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);

    await result;
    expect(serverApiMock).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticateAndRedirect } from "./auth-form";

afterEach(() => vi.unstubAllGlobals());

describe("authentication navigation", () => {
  it("reloads the app after login so the account header uses the new session", async () => {
    const replace = vi.fn();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ user: { displayName: "김민태" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { replace } });

    await authenticateAndRedirect("login", { email: "user@example.com", password: "password" });

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", expect.any(Object));
    expect(replace).toHaveBeenCalledWith("/families");
  });
});

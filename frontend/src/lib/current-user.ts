import "server-only";
import { ServerApiError, serverApi } from "./server-api";

type CurrentUser = {
  displayName: string;
};

const retryDelays = [250];

export async function currentUser(): Promise<CurrentUser | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return (await serverApi<{ user: CurrentUser }>("/auth/me")).user;
    } catch (error) {
      if (error instanceof ServerApiError && error.status === 401) return null;
      const delay = retryDelays[attempt];
      if (error instanceof ServerApiError && error.status === 503 && delay === undefined) return null;
      if (!(error instanceof ServerApiError) || error.status !== 503 || delay === undefined) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

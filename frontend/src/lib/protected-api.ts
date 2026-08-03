import { notFound, redirect } from "next/navigation";
import { ServerApiError, serverApi } from "./server-api";

export async function protectedApi<T>(path: string): Promise<T> {
  try {
    return await serverApi<T>(path);
  } catch (error) {
    if (error instanceof ServerApiError && error.status === 401) redirect("/login");
    if (error instanceof ServerApiError && error.status === 404) notFound();
    throw error;
  }
}

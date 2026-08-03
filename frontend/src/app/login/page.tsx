import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { ServerApiError, serverApi } from "@/lib/server-api";

export default async function LoginPage() {
  try {
    await serverApi("/auth/me");
    redirect("/families");
  } catch (error) {
    if (!(error instanceof ServerApiError) || ![401, 503].includes(error.status)) throw error;
  }
  return <AuthForm mode="login" />;
}

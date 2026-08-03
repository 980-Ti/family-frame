import { notFound } from "next/navigation";
import { InviteCard } from "@/components/invite-card";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const origin = process.env.API_ORIGIN ?? "http://localhost:4000";
  const response = await fetch(`${origin}/api/invites/${token}`, { cache: "no-store" });
  if (!response.ok) notFound();
  const invite = await response.json() as { familyName: string; email: string };
  return <InviteCard token={token} familyName={invite.familyName} email={invite.email} />;
}

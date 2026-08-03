"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { clientApi } from "@/lib/api";
import type { ChildTag } from "@/lib/types";

export function AlbumSettings({
  familyId,
  albumId,
  childTags,
  isOwner
}: {
  familyId: string;
  albumId: string;
  childTags: ChildTag[];
  isOwner: boolean;
}) {
  const router = useRouter();
  const tagPendingRef = useRef(false);
  const invitePendingRef = useRef(false);
  const [tagError, setTagError] = useState("");
  const [tagPending, setTagPending] = useState(false);
  const [deletingTagId, setDeletingTagId] = useState<string | null>(null);
  const [removedTagIds, setRemovedTagIds] = useState<string[]>([]);
  const [inviteError, setInviteError] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const [invitePending, setInvitePending] = useState(false);
  const visibleChildTags = childTags.filter((tag) => !removedTagIds.includes(tag.id));
  const childTagLimitReached = visibleChildTags.length >= 10;

  async function createChildTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (tagPendingRef.current) return;
    tagPendingRef.current = true;
    const form = event.currentTarget;
    const data = new FormData(form);
    setTagError("");
    setTagPending(true);

    try {
      await clientApi(`/albums/${albumId}/child-tags`, {
        method: "POST",
        body: JSON.stringify({ name: data.get("name") })
      });
      form.reset();
      router.refresh();
    } catch (reason) {
      setTagError(reason instanceof Error ? reason.message : "아이 이름을 추가하지 못했습니다.");
    } finally {
      tagPendingRef.current = false;
      setTagPending(false);
    }
  }

  async function createInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invitePendingRef.current) return;
    invitePendingRef.current = true;
    const form = event.currentTarget;
    const data = new FormData(form);
    setInviteError("");
    setInvitePending(true);

    try {
      const result = await clientApi<{ token: string }>(`/families/${familyId}/invites`, {
        method: "POST",
        body: JSON.stringify({ email: data.get("email") })
      });
      setInviteLink(`${location.origin}/invite/${result.token}`);
      form.reset();
    } catch (reason) {
      setInviteError(reason instanceof Error ? reason.message : "초대 링크를 만들지 못했습니다.");
    } finally {
      invitePendingRef.current = false;
      setInvitePending(false);
    }
  }

  async function deleteChildTag(tag: ChildTag) {
    if (deletingTagId !== null) return;

    setTagError("");
    setDeletingTagId(tag.id);
    try {
      await clientApi<void>(`/albums/${albumId}/child-tags/${tag.id}`, {
        method: "DELETE"
      });
      setRemovedTagIds((current) => [...current, tag.id]);
      router.refresh();
    } catch (reason) {
      setTagError(reason instanceof Error ? reason.message : "아이 이름표를 삭제하지 못했습니다.");
    } finally {
      setDeletingTagId(null);
    }
  }

  if (!isOwner) {
    return <p className="muted text-sm">앨범 초대는 앨범을 만든 사람만 관리할 수 있어요.</p>;
  }

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-lg font-bold">아이 이름 태그</h2>
        <p className="muted mt-2 text-sm">사진을 올릴 때 직접 선택할 이름이에요. 자동으로 판별하지 않습니다.</p>
        {visibleChildTags.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {visibleChildTags.map((tag) => (
              <AlertDialog key={tag.id}>
                <Badge className="max-w-full gap-1 py-0.5 pr-1" variant="outline">
                  <span className="min-w-0 truncate" title={tag.name}>{tag.name}</span>
                  <AlertDialogTrigger asChild>
                    <button
                      type="button"
                      className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50"
                      aria-label={`${tag.name} 이름표 삭제`}
                      title={`${tag.name} 이름표 삭제`}
                      disabled={deletingTagId !== null}
                    >
                      <X aria-hidden="true" className="size-3.5" />
                    </button>
                  </AlertDialogTrigger>
                </Badge>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>&ldquo;{tag.name}&rdquo; 이름표를 삭제할까요?</AlertDialogTitle>
                    <AlertDialogDescription>
                      사진은 삭제되지 않고 이 이름표만 제거됩니다.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>취소</AlertDialogCancel>
                    <AlertDialogAction
                      disabled={deletingTagId !== null}
                      onClick={() => void deleteChildTag(tag)}
                    >
                      이름표 삭제
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ))}
          </div>
        ) : (
          <p className="muted mt-4 text-sm">아직 추가한 아이 이름이 없어요.</p>
        )}
        <form onSubmit={createChildTag} className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] gap-3">
          <Input
            name="name"
            placeholder="추가할 아이 이름…"
            aria-label="추가할 아이 이름"
            autoComplete="off"
            required
            disabled={tagPending || childTagLimitReached}
          />
          <Button className="shrink-0" type="submit" disabled={tagPending || childTagLimitReached}>
            {tagPending ? "추가 중…" : "아이 추가"}
          </Button>
        </form>
        {childTagLimitReached ? (
          <p className="muted mt-2 text-sm">아이 이름은 최대 10개까지 추가할 수 있어요.</p>
        ) : null}
        {tagError ? (
          <Alert variant="destructive" className="mt-3" role="alert" aria-live="polite">
            <AlertDescription>{tagError}</AlertDescription>
          </Alert>
        ) : null}
      </section>

      <Separator />
      <form onSubmit={createInvite}>
        <h2 className="text-lg font-bold">가족 초대</h2>
        <Label className="mt-5 block" htmlFor="inviteEmail">초대할 사람의 이메일</Label>
        <p className="muted mt-2 text-sm">이 이메일로 가입하거나 로그인한 사람만 초대를 받을 수 있어요.</p>
        <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] gap-3">
          <Input
            id="inviteEmail"
            name="email"
            type="email"
            placeholder="예: name@example.com…"
            autoComplete="email"
            spellCheck={false}
            required
            disabled={invitePending}
          />
          <Button className="shrink-0" type="submit" disabled={invitePending}>
            {invitePending ? "만드는 중…" : "초대 링크 만들기"}
          </Button>
        </div>
        {inviteLink && (
          <Alert className="mt-5 border-primary/20 bg-primary/5" aria-live="polite">
            <AlertTitle>초대 링크가 준비됐어요</AlertTitle>
            <AlertDescription>
              <a className="break-all text-primary underline underline-offset-4" href={inviteLink}>{inviteLink}</a>
              <p className="muted mt-2 text-xs">링크는 7일 동안 사용할 수 있어요.</p>
            </AlertDescription>
          </Alert>
        )}
        {inviteError ? (
          <Alert variant="destructive" className="mt-4" role="alert" aria-live="polite">
            <AlertDescription>{inviteError}</AlertDescription>
          </Alert>
        ) : null}
      </form>
    </div>
  );
}

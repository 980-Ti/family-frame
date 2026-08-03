import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { HeaderAccount } from "@/components/header-account";
import { currentUser } from "@/lib/current-user";
import "./globals.css";

export const metadata: Metadata = {
  title: "Family Frame",
  description: "가족만 함께 보는 아이의 하루"
};

export const viewport: Viewport = { themeColor: "#f3f6f2" };

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await currentUser();

  return (
    <html lang="ko">
      <body>
        <a
          href="#main-content"
          className="fixed left-3 top-3 z-50 -translate-y-20 rounded-lg bg-black px-4 py-2 text-sm font-semibold text-white focus:translate-y-0"
        >
          본문으로 이동
        </a>
        <header className="site-header">
          <div className="shell site-header-inner">
            <Link href="/families" className="brand-link" aria-label="Family Frame 홈">
              <span className="brand-mark" aria-hidden="true">F</span>
              <span className="brand text-lg font-extrabold">Family Frame</span>
            </Link>
            {user && <HeaderAccount displayName={user.displayName} />}
          </div>
        </header>
        <main id="main-content" className="shell main-shell">
          {children}
        </main>
      </body>
    </html>
  );
}

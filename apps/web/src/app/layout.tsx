import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "lastGreen — Playwright Failure Diff & Triage",
  description:
    "Upload a failing Playwright report, compare it against a passing run, and find the first meaningful divergence.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-zinc-950 text-zinc-100`}
      >
        <nav className="border-b border-zinc-800 px-6 py-4">
          <a href="/" className="text-lg font-semibold tracking-tight">
            lastGreen
          </a>
          <span className="ml-3 text-sm text-zinc-500">
            Playwright failure diff & triage
          </span>
        </nav>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}

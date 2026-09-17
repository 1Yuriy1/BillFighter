import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BillFighter",
  description:
    "An AI case worker that turns medical bills, EOBs, and denial letters into findings, appeal letters, and confirmed savings.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}

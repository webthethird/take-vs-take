import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Take vs. Take",
  description: "Two X posts in, two hypothetical portfolios out, compared fairly over a common window.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import { Geist, Geist_Mono, Orbitron } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { PostHogProvider } from "@/lib/posthog/PostHogProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const orbitron = Orbitron({
  variable: "--font-orbitron",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://ethglobalmumbai.vercel.app'),
  title: "Strike - Trade over 300+ Crypto, Stocks, Metals and Forex with 5s-1m time-charts",
  description:
    "The first on-chain binary options trading dapp. Powered by oracle-backed price attestations and minimal-trust settlement.",
  keywords: [
    "binary options",
    "crypto trading",
    "price feeds",
    "Arc",
    "USDC",
    "Web3",
    "prediction",
  ],
  icons: {
    icon: "/overflowlogo.ico",
    shortcut: "/overflowlogo.ico",
    apple: "/overflowlogo.ico",
  },
  openGraph: {
    title: "Strike — Trade over 300+ Crypto, Stocks, Metals and Forex with 5s-1m time-charts",
    description:
      "The first on-chain binary options trading dapp with oracle-backed price attestations and minimal-trust settlement.",
    images: [{ url: '/overflowlogo.png', width: 512, height: 512, alt: 'Strike' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: "Strike — Trade over 300+ Crypto, Stocks, Metals and Forex with 5s-1m time-charts",
    description: "Trade binary options with oracle-bound resolution and minimal trust.",
    images: ['/overflowlogo.png'],
  },
};

import { Header } from "@/components/Header";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        suppressHydrationWarning
        className={`${geistSans.variable} ${geistMono.variable} ${orbitron.variable} antialiased bg-[#02040a] text-white h-screen overflow-hidden flex flex-col`}
      >
        <PostHogProvider>
          <Providers>
            <Header />
            {/* Body is h-screen overflow-hidden: this must scroll or every page taller than the viewport is clipped. */}
            <main className="flex-1 relative flex flex-col min-h-0 min-w-0 overflow-y-auto overflow-x-hidden">
              {children}
            </main>
          </Providers>
        </PostHogProvider>
      </body>
    </html>
  );
}

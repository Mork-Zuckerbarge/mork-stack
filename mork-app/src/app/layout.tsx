import type { Metadata } from "next";
import Script from "next/script";
import { ensurePlannerAutopilotStarted } from "@/lib/core/plannerAutopilot";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mork App",
  description: "Mork control panel",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  ensurePlannerAutopilotStarted();
  return (
    <html lang="en">
      <body>
        {children}
        <Script
          src="https://plugin.jup.ag/plugin-v1.js"
          strategy="beforeInteractive"
          data-preload
          defer
        />
      </body>
    </html>
  );
}

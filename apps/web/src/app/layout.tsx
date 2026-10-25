import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Warike POS", template: "%s · Warike POS" },
  description: "Punto de venta de Warike Resto Grill: salón, caja, cocina y reportes.",
  applicationName: "Warike POS",
  appleWebApp: { capable: true, title: "Warike POS", statusBarStyle: "default" },
  formatDetection: { telephone: false },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/icon-192.png" },
};

export const viewport: Viewport = {
  themeColor: "#b4321e",
  width: "device-width",
  initialScale: 1,
  // Tablets en modo kiosco: sin zoom accidental al tocar.
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es-PE">
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

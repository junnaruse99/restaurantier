import type { MetadataRoute } from "next";

// Instalable en Android, iPad y Windows (§3).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Warike POS",
    short_name: "Warike POS",
    description: "Punto de venta de Warike Resto Grill",
    lang: "es-PE",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#fbf8f5",
    theme_color: "#b4321e",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

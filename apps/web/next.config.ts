import withSerwistInit from "@serwist/next";
import type { NextConfig } from "next";

const desarrollo = process.env.NODE_ENV === "development";
const supabaseOrigen = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321")
  .origin;

// §14.10: cabeceras CSP y HSTS.
const politicaContenido = [
  "default-src 'self'",
  // Next.js inyecta scripts en línea para la hidratación.
  `script-src 'self' 'unsafe-inline'${desarrollo ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // data: para el QR de enrolamiento TOTP que entrega Supabase Auth.
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self' ${supabaseOrigen} ${supabaseOrigen.replace(/^http/, "ws")}`,
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  disable: desarrollo,
});

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@warike/ui", "@warike/domain"],
  // Konva trae una entrada para Node que pide el paquete opcional "canvas"; el editor del plano solo
  // corre en el navegador (next/dynamic sin SSR).
  webpack(config: { resolve: { alias: Record<string, unknown> } }) {
    config.resolve.alias = { ...config.resolve.alias, canvas: false };
    return config;
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: politicaContenido },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default withSerwist(nextConfig);

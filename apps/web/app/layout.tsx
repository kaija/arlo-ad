import type { ReactNode } from 'react';
import localFont from 'next/font/local';
import './globals.css';

// Design system fonts: Inter 400–700; Fira Code backs the mono stack off Apple platforms.
// Self-hosted from @fontsource-variable: next/font/google fetches at compile time, and in the
// Linux dev container Google answers with `/l/font?kit=…&skey=…` URLs that Turbopack cannot resolve.
const inter = localFont({ src: '../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', weight: '400 700', variable: '--font-inter', display: 'swap' });
const firaCode = localFont({ src: '../node_modules/@fontsource-variable/fira-code/files/fira-code-latin-wght-normal.woff2', weight: '400 500', variable: '--font-fira-code', display: 'swap' });

export const metadata = {
  title: 'Arlo Ads Bot · Console',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-Hant" className={`${inter.variable} ${firaCode.variable}`}>
      <body>{children}</body>
    </html>
  );
}

import type { ReactNode } from 'react';
import { Fira_Code, Inter } from 'next/font/google';
import './globals.css';

// Design system fonts: Inter 400–700; Fira Code backs the mono stack off Apple platforms.
const inter = Inter({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-inter', display: 'swap' });
const firaCode = Fira_Code({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-fira-code', display: 'swap' });

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

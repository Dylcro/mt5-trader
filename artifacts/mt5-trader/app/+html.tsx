import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

const TITLE = "XAUUSD Trader — MetaTrader 5 Gold Cascade App";
const DESCRIPTION =
  "Trade XAUUSD gold on MetaTrader 5 with automated cascade ladder orders, four take-profit levels, automatic risk-free break-even moves, and one-tap zone management.";

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />
        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <meta name="application-name" content="XAUUSD Trader" />
        <meta name="theme-color" content="#C9A84C" />
        <meta name="robots" content="index, follow" />
        <link rel="canonical" href="https://meta-trader-link.replit.app/" />
        <meta property="og:type" content="website" />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <meta property="og:url" content="https://meta-trader-link.replit.app/" />
        <meta property="og:site_name" content="XAUUSD Trader" />
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content={TITLE} />
        <meta name="twitter:description" content={DESCRIPTION} />
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}

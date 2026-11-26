import localFont from "next/font/local";

// Auni's two faces, from this app's own packages, so the build and the page fetch nothing and
// every machine draws the same letters (a system stack is Arial on Linux and Windows).

/** Inter, with its optical-size axis: big figures take its display cut by themselves. */
const inter = localFont({
  src: [
    {
      path: "../node_modules/@fontsource-variable/inter/files/inter-latin-standard-normal.woff2",
      style: "normal",
    },
    {
      path: "../node_modules/@fontsource-variable/inter/files/inter-latin-standard-italic.woff2",
      style: "italic",
    },
  ],
  weight: "100 900",
  display: "swap",
  variable: "--font-inter",
});

/** JetBrains Mono: addresses, hashes and commands, and nothing else. */
const jetbrainsMono = localFont({
  src: "../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
  weight: "100 800",
  display: "swap",
  variable: "--font-jetbrains",
  preload: false,
});

/** Both, as the classes that put their variables on the document. */
export const FONT_VARIABLES = `${inter.variable} ${jetbrainsMono.variable}`;

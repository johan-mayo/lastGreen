import type { Metadata } from "next";
import { Suspense } from "react";
import {
  MantineProvider,
  ColorSchemeScript,
  Box,
} from "@mantine/core";
import { theme } from "./theme";
import { NavBar } from "./components/nav-bar";
import "./globals.css";

export const metadata: Metadata = {
  title: "lastGreen — Playwright Failure Diff & Triage",
  description:
    "Upload a failing Playwright report, compare it against a passing run, and find the first meaningful divergence.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-mantine-color-scheme="dark">
      <head>
        <ColorSchemeScript defaultColorScheme="dark" />
      </head>
      <body>
        <MantineProvider theme={theme} defaultColorScheme="dark">
          <Suspense>
            <NavBar />
          </Suspense>

          <Box px="lg" py="lg">
            {children}
          </Box>
        </MantineProvider>
      </body>
    </html>
  );
}

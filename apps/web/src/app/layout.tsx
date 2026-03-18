import type { Metadata } from "next";
import {
  MantineProvider,
  ColorSchemeScript,
  Anchor,
  Text,
  Group,
  Box,
  Container,
} from "@mantine/core";
import { theme } from "./theme";
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
          <Box
            component="nav"
            px="md"
            py="sm"
            style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}
          >
            <Group>
              <Anchor href="/" underline="never" c="white" fw={600} fz="lg">
                lastGreen
              </Anchor>
              <Text size="sm" c="dimmed">
                Playwright failure diff &amp; triage
              </Text>
            </Group>
          </Box>

          <Container size="xl" py="lg">
            {children}
          </Container>
        </MantineProvider>
      </body>
    </html>
  );
}

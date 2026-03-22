"use client";

import { useSearchParams } from "next/navigation";
import { Anchor, Text, Group, Box } from "@mantine/core";

export function NavBar() {
  const searchParams = useSearchParams();
  const locked = searchParams.get("locked") === "1";

  if (locked) return null;

  return (
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
  );
}

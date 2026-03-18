"use client";

import { useState, type ReactNode } from "react";
import {
  Box,
  Collapse,
  Group,
  Paper,
  Text,
  UnstyledButton,
} from "@mantine/core";

export function AccordionCard({
  title,
  children,
  defaultOpen = true,
  rightSection,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  rightSection?: ReactNode;
}) {
  const [opened, setOpened] = useState(defaultOpen);

  return (
    <Paper radius="md" bg="dark.6">
      <UnstyledButton
        onClick={() => setOpened((v) => !v)}
        w="100%"
        px="lg"
        py="sm"
      >
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Text
              size="xs"
              c="dimmed"
              style={{
                transition: "transform 150ms ease",
                transform: opened ? "rotate(90deg)" : "rotate(0deg)",
              }}
            >
              &#9656;
            </Text>
            <Text size="xs" fw={600} tt="uppercase" c="dimmed">
              {title}
            </Text>
          </Group>
          {rightSection && (
            <Box onClick={(e: React.MouseEvent) => e.stopPropagation()}>
              {rightSection}
            </Box>
          )}
        </Group>
      </UnstyledButton>
      <Collapse in={opened}>
        <Box px="lg" pb="lg">
          {children}
        </Box>
      </Collapse>
    </Paper>
  );
}

"use client";

import { useState, useMemo } from "react";
import type {
  NormalizedTestCase,
  NetworkRequest,
} from "@last-green/core";
import {
  Badge,
  Code,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  Button,
  Card,
  Image,
  SimpleGrid,
  Title,
} from "@mantine/core";
import { NetworkRequestsPanel } from "./results-view";

export function PassingPanel({
  passingTest,
  passingNetworkRequests,
  sessionId,
}: {
  passingTest: NormalizedTestCase | null;
  passingNetworkRequests: Record<string, NetworkRequest[]>;
  sessionId: string;
}) {
  if (!passingTest) {
    return (
      <Paper p="lg" radius="md" bg="dark.6">
        <Text c="dimmed">No matching passing test found.</Text>
      </Paper>
    );
  }

  const [attemptIdx, setAttemptIdx] = useState(() => {
    const idx = passingTest.results.findIndex((r) => r.status === "passed");
    return idx >= 0 ? idx : passingTest.results.length - 1;
  });
  const currentAttempt = passingTest.results[attemptIdx];

  const networkRequests = useMemo(() => {
    if (!currentAttempt) return [];
    const key = `${passingTest.id}:${currentAttempt.attempt}`;
    return passingNetworkRequests[key] ?? [];
  }, [passingTest.id, currentAttempt, passingNetworkRequests]);

  const failingRequests = useMemo(
    () => networkRequests.filter((r) => r.failed),
    [networkRequests]
  );

  const steps = currentAttempt?.steps ?? [];
  const artifacts = currentAttempt?.artifacts ?? [];
  const screenshots = artifacts.filter(
    (a) => a.type === "screenshot" && a.contentType.startsWith("image/")
  );
  const videos = artifacts.filter(
    (a) => a.type === "video" && a.contentType.startsWith("video/")
  );
  const stderr = currentAttempt?.stderr ?? [];

  return (
    <Stack gap="md">
      {/* Header */}
      <Paper p="lg" radius="md" bg="dark.6">
        <Group gap="sm" mb="xs">
          <Badge color="green" variant="light">passed</Badge>
          <Text size="xs" c="dimmed">
            {currentAttempt?.duration ? `${Math.round(currentAttempt.duration / 1000)}s` : ""}
          </Text>
        </Group>
        <Title order={4}>{passingTest.fullTitle}</Title>
        <Text size="xs" c="dimmed" mt={4}>{passingTest.filePath}</Text>
      </Paper>

      {/* Attempt toggle */}
      {passingTest.results.length > 1 && (
        <Paper p="md" radius="md" bg="dark.6">
          <Group gap="sm">
            <Text size="sm" fw={500} c="dimmed">Attempt:</Text>
            <Group gap={4}>
              {passingTest.results.map((attempt, i) => (
                <Button
                  key={i}
                  onClick={() => setAttemptIdx(i)}
                  size="xs"
                  variant={i === attemptIdx ? "filled" : "subtle"}
                  color={i === attemptIdx
                    ? (attempt.status === "passed" ? "green" : "red")
                    : "gray"
                  }
                >
                  {i + 1}{" "}
                  <Text span size="xs" ml={4}>
                    {attempt.status === "passed" ? "pass" : "fail"}
                  </Text>
                </Button>
              ))}
            </Group>
          </Group>
        </Paper>
      )}

      {/* Steps */}
      {steps.length > 0 && (
        <Paper p="lg" radius="md" bg="dark.6">
          <Text size="xs" fw={600} tt="uppercase" c="dimmed">
            Test steps
          </Text>
          <Table mt="md" fz="xs" horizontalSpacing="xs" verticalSpacing={6}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={40}>#</Table.Th>
                <Table.Th w={64}>Status</Table.Th>
                <Table.Th>Step</Table.Th>
                <Table.Th w={72}>Duration</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {steps.map((step, i) => {
                const hasError = !!step.error;
                return (
                  <Table.Tr key={i}>
                    <Table.Td c="dimmed">{i}</Table.Td>
                    <Table.Td>
                      <Badge size="xs" color={hasError ? "red" : "green"} variant="light">
                        {hasError ? "fail" : "pass"}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" truncate="end">{step.title}</Text>
                    </Table.Td>
                    <Table.Td c="dimmed">{step.duration}ms</Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Paper>
      )}

      {/* Non-2xx network requests */}
      {failingRequests.length > 0 && (
        <NetworkRequestsPanel requests={failingRequests} />
      )}

      {/* Screenshots */}
      {screenshots.length > 0 && (
        <Paper p="lg" radius="md" bg="dark.6">
          <Text size="xs" fw={600} tt="uppercase" c="dimmed" mb="sm">
            Screenshots
          </Text>
          <SimpleGrid cols={1} spacing="md">
            {screenshots.map((s, i) => (
              <Card key={i} padding={0} radius="sm" withBorder>
                <Card.Section>
                  <Image
                    src={`/api/artifacts/${sessionId}?path=${encodeURIComponent(s.path)}`}
                    alt={s.name}
                    style={{ cursor: "pointer" }}
                    onClick={() => window.open(`/api/artifacts/${sessionId}?path=${encodeURIComponent(s.path)}`, "_blank")}
                  />
                </Card.Section>
                <Text size="xs" c="dimmed" p="xs" truncate="end">
                  {s.name}
                </Text>
              </Card>
            ))}
          </SimpleGrid>
        </Paper>
      )}

      {/* Videos */}
      {videos.length > 0 && (
        <Paper p="lg" radius="md" bg="dark.6">
          <Text size="xs" fw={600} tt="uppercase" c="dimmed" mb="sm">
            Videos
          </Text>
          <Stack gap="md">
            {videos.map((v, i) => (
              <Card key={i} padding={0} radius="sm" withBorder>
                <Card.Section>
                  <video
                    src={`/api/artifacts/${sessionId}?path=${encodeURIComponent(v.path)}`}
                    controls
                    style={{ width: "100%", display: "block" }}
                  />
                </Card.Section>
                <Text size="xs" c="dimmed" p="xs" truncate="end">
                  {v.name}
                </Text>
              </Card>
            ))}
          </Stack>
        </Paper>
      )}

      {/* Console stderr */}
      {stderr.length > 0 && (
        <Paper p="lg" radius="md" bg="dark.6">
          <Text size="xs" fw={600} tt="uppercase" c="dimmed" mb="sm">
            Console output
          </Text>
          <Code block style={{ maxHeight: 256, overflow: "auto", whiteSpace: "pre-wrap", fontSize: "var(--mantine-font-size-xs)" }}>
            {stderr.join("\n")}
          </Code>
        </Paper>
      )}
    </Stack>
  );
}

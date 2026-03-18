"use client";

import { useMemo } from "react";
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
  Card,
  Image,
  SimpleGrid,
  Title,
} from "@mantine/core";
import { NetworkRequestsPanel } from "../../components/network-requests-panel";

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

  const passingAttempt = passingTest.results.find((r) => r.status === "passed");

  if (!passingAttempt) {
    return (
      <Paper p="lg" radius="md" bg="dark.6">
        <Text c="dimmed">
          No passing attempt found for the compared test. All {passingTest.results.length} attempt{passingTest.results.length !== 1 ? "s" : ""} failed.
        </Text>
      </Paper>
    );
  }

  const networkRequests = useMemo(() => {
    const key = `${passingTest.id}:${passingAttempt.attempt}`;
    return passingNetworkRequests[key] ?? [];
  }, [passingTest.id, passingAttempt, passingNetworkRequests]);

  const failingRequests = useMemo(
    () => networkRequests.filter((r) => r.failed),
    [networkRequests]
  );

  const steps = passingAttempt.steps ?? [];
  const artifacts = passingAttempt.artifacts ?? [];
  const screenshots = artifacts.filter(
    (a) => a.type === "screenshot" && a.contentType.startsWith("image/")
  );
  const videos = artifacts.filter(
    (a) => a.type === "video" && a.contentType.startsWith("video/")
  );
  const stderr = passingAttempt.stderr ?? [];

  return (
    <Stack gap="md">
      {/* Header */}
      <Paper p="lg" radius="md" bg="dark.6">
        <Group gap="sm" mb="xs">
          <Badge color="green" variant="light">passed</Badge>
          <Text size="xs" c="dimmed">
            {passingAttempt.duration ? `${Math.round(passingAttempt.duration / 1000)}s` : ""}
          </Text>
        </Group>
        <Title order={4}>{passingTest.fullTitle}</Title>
        <Text size="xs" c="dimmed" mt={4}>{passingTest.filePath}</Text>
      </Paper>

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

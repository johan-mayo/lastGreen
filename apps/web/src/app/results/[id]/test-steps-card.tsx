"use client";

import type { Divergence } from "@last-green/core";
import type { CompareResult } from "@last-green/core";
import {
  Alert,
  Badge,
  Box,
  Code,
  Group,
  SimpleGrid,
  Stack,
  Table,
  Text,
} from "@mantine/core";

function normalizeStepTitle(title: string): string {
  return title.replace(/[\s"']+/g, " ").trim().toLowerCase();
}

function stepTitlesMatch(a: string, b: string): boolean {
  return normalizeStepTitle(a) === normalizeStepTitle(b);
}

function DivergenceSummary({
  divergence,
  hasPassingRun,
}: {
  divergence: Divergence | null;
  hasPassingRun: boolean;
}) {
  if (!divergence) return null;

  if (!hasPassingRun) {
    return (
      <Alert
        variant="light"
        color="red"
        title={`Failing step \u2014 step ${divergence.stepIndex}`}
        radius="md"
      >
        <Code block>{divergence.failingStep?.title ?? "Unknown step"}</Code>
        <Text size="sm" c="dimmed" mt="xs">
          {divergence.description}
        </Text>
        <Group gap="xs" mt="sm">
          <Badge size="sm" variant="outline" color="gray">
            Significance: {divergence.significance}
          </Badge>
        </Group>
      </Alert>
    );
  }

  return (
    <Alert
      variant="light"
      color="yellow"
      title={`First divergence \u2014 step ${divergence.stepIndex}`}
      radius="md"
    >
      <Text size="sm">{divergence.description}</Text>
      <Group gap="xs" mt="sm">
        <Badge size="sm" variant="outline" color="gray">
          Type: {divergence.type.replace(/_/g, " ")}
        </Badge>
        <Badge size="sm" variant="outline" color="gray">
          Significance: {divergence.significance}
        </Badge>
      </Group>
      <SimpleGrid cols={2} mt="md" spacing="md">
        <Box>
          <Text size="xs" fw={600} tt="uppercase" c="red">
            Failing step
          </Text>
          <Code block style={{ fontSize: "var(--mantine-font-size-xs)" }}>
            {divergence.failingStep?.title ?? "\u2014"}
          </Code>
        </Box>
        <Box>
          <Text size="xs" fw={600} tt="uppercase" c="green">
            Passing step
          </Text>
          <Code block style={{ fontSize: "var(--mantine-font-size-xs)" }}>
            {divergence.passingStep?.title ?? "\u2014"}
          </Code>
        </Box>
      </SimpleGrid>
    </Alert>
  );
}

function StepsTable({
  attempt,
  compare,
  hasPassingRun,
}: {
  attempt:
    | {
        steps: {
          title: string;
          duration: number;
          error?: { message?: string };
        }[];
      }
    | undefined;
  compare: CompareResult;
  hasPassingRun: boolean;
}) {
  const steps = attempt?.steps ?? [];
  const passSteps =
    compare.match.passingTest?.results[
      compare.match.passingTest.results.length - 1
    ]?.steps ?? [];

  if (steps.length === 0 && passSteps.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No steps recorded.
      </Text>
    );
  }

  if (!hasPassingRun || passSteps.length === 0) {
    return (
      <Table fz="xs" horizontalSpacing="xs" verticalSpacing={6}>
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
              <Table.Tr
                key={i}
                bg={hasError ? "rgba(220, 38, 38, 0.1)" : undefined}
              >
                <Table.Td c="dimmed">{i}</Table.Td>
                <Table.Td>
                  <Badge
                    size="xs"
                    color={hasError ? "red" : "green"}
                    variant="light"
                  >
                    {hasError ? "fail" : "pass"}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" truncate="end">
                    {step.title}
                  </Text>
                  {step.error?.message && (
                    <Text size="xs" c="red" truncate="end" mt={2}>
                      {step.error.message.slice(0, 80)}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td c="dimmed">{step.duration}ms</Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    );
  }

  const maxLen = Math.max(steps.length, passSteps.length);

  return (
    <Box style={{ overflow: "auto" }}>
      <Table fz="xs" horizontalSpacing="xs" verticalSpacing={6}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={40}>#</Table.Th>
            <Table.Th c="red">Failing</Table.Th>
            <Table.Th w={56} c="red">
              ms
            </Table.Th>
            <Table.Th c="green">Passing</Table.Th>
            <Table.Th w={56} c="green">
              ms
            </Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {Array.from({ length: maxLen }, (_, i) => {
            const fs = steps[i];
            const ps = passSteps[i];
            const isDivergent =
              (fs && ps && !stepTitlesMatch(fs.title, ps.title)) ||
              (fs && !ps && i < passSteps.length) ||
              (!fs && ps && i < steps.length) ||
              (fs?.error && !ps?.error);

            return (
              <Table.Tr
                key={i}
                bg={isDivergent ? "rgba(217, 119, 6, 0.1)" : undefined}
              >
                <Table.Td c="dimmed">{i}</Table.Td>
                <Table.Td>
                  <Text size="xs" truncate="end">
                    {fs?.title ?? "\u2014"}
                    {fs?.error?.message && (
                      <Text span size="xs" c="red" ml={4}>
                        {fs.error.message.slice(0, 40)}
                      </Text>
                    )}
                  </Text>
                </Table.Td>
                <Table.Td c="dimmed">{fs?.duration ?? "\u2014"}</Table.Td>
                <Table.Td>
                  <Text size="xs" truncate="end">
                    {ps?.title ?? "\u2014"}
                  </Text>
                </Table.Td>
                <Table.Td c="dimmed">{ps?.duration ?? "\u2014"}</Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Box>
  );
}

export function TestStepsCard({
  divergence,
  attempt,
  compare,
  hasPassingRun,
}: {
  divergence: Divergence | null;
  attempt:
    | {
        steps: {
          title: string;
          duration: number;
          error?: { message?: string };
        }[];
      }
    | undefined;
  compare: CompareResult;
  hasPassingRun: boolean;
}) {
  return (
    <Stack gap="md">
      <DivergenceSummary divergence={divergence} hasPassingRun={hasPassingRun} />
      <StepsTable attempt={attempt} compare={compare} hasPassingRun={hasPassingRun} />
    </Stack>
  );
}

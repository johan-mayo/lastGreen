"use client";

import type { TriageSummary } from "@last-green/core";
import { Badge, Group, Paper, Text, Title } from "@mantine/core";

export function TriageCard({
  triage,
  suggestedNextStep,
}: {
  triage: TriageSummary;
  suggestedNextStep?: string;
}) {
  return (
    <>
      <Title order={3}>{triage.testCase.fullTitle}</Title>
      <Text size="sm" mt="xs">
        {triage.summary}
      </Text>
      <Group gap="sm" mt="md">
        <CategoryBadge category={triage.category} />
        <ConfidenceBadge confidence={triage.confidence} />
      </Group>
      <Paper p="sm" radius="sm" mt="md" bg="dark.5">
        <Text size="sm">
          <Text span fw={500}>
            Next step:{" "}
          </Text>
          {suggestedNextStep ?? triage.suggestedNextStep}
        </Text>
      </Paper>
    </>
  );
}

export function CategoryBadge({ category }: { category: string }) {
  const colors: Record<string, string> = {
    app_regression: "red",
    flaky_timing: "yellow",
    environment_issue: "blue",
    test_bug: "violet",
    unknown: "gray",
  };

  return (
    <Badge size="sm" variant="light" color={colors[category] ?? "gray"}>
      {category.replace(/_/g, " ")}
    </Badge>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: string }) {
  const color =
    confidence === "high"
      ? "green"
      : confidence === "medium"
        ? "yellow"
        : "gray";

  return (
    <Text size="xs" c={color}>
      {confidence} confidence
    </Text>
  );
}

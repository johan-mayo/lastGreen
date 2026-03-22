"use client";

import type { EvidenceItem, Artifact } from "@last-green/core";
import { withBasePath } from "../../lib/base-path";
import {
  Badge,
  Box,
  Card,
  Image,
  List,
  SimpleGrid,
  Stack,
  Text,
} from "@mantine/core";

export function EvidenceCard({
  evidence,
  artifacts,
  sessionId,
}: {
  evidence: EvidenceItem[];
  artifacts: Artifact[];
  sessionId: string;
}) {
  const items = evidence.filter((e) => e.type !== "error_message");
  const screenshots = artifacts.filter(
    (a) => a.type === "screenshot" && a.contentType.startsWith("image/"),
  );
  const videos = artifacts.filter(
    (a) => a.type === "video" && a.contentType.startsWith("video/"),
  );

  return (
    <>
      {items.length > 0 && (
        <List spacing="xs" size="sm">
          {items.map((e, i) => (
            <List.Item key={i} icon={<EvidenceIcon type={e.type} />}>
              {e.description}
            </List.Item>
          ))}
        </List>
      )}
      {screenshots.length > 0 && (
        <Box mt={items.length > 0 ? "md" : undefined}>
          <Text size="xs" fw={600} tt="uppercase" c="dimmed" mb="sm">
            Screenshots
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
            {screenshots.map((s, i) => (
              <Card key={i} padding={0} radius="sm" withBorder>
                <Card.Section>
                  <Image
                    src={`${withBasePath(`/api/artifacts/${sessionId}`)}?path=${encodeURIComponent(s.path)}`}
                    alt={s.name}
                    style={{ cursor: "pointer" }}
                    onClick={() =>
                      window.open(
                        `${withBasePath(`/api/artifacts/${sessionId}`)}?path=${encodeURIComponent(s.path)}`,
                        "_blank",
                      )
                    }
                  />
                </Card.Section>
                <Text size="xs" c="dimmed" p="xs" truncate="end">
                  {s.name}
                </Text>
              </Card>
            ))}
          </SimpleGrid>
        </Box>
      )}
      {videos.length > 0 && (
        <Box
          mt={items.length > 0 || screenshots.length > 0 ? "md" : undefined}
        >
          <Text size="xs" fw={600} tt="uppercase" c="dimmed" mb="sm">
            Videos
          </Text>
          <Stack gap="md">
            {videos.map((v, i) => (
              <Card key={i} padding={0} radius="sm" withBorder>
                <Card.Section>
                  <video
                    src={`${withBasePath(`/api/artifacts/${sessionId}`)}?path=${encodeURIComponent(v.path)}`}
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
        </Box>
      )}
    </>
  );
}

export function EvidenceIcon({ type }: { type: string }) {
  const icons: Record<string, string> = {
    screenshot_diff: "img",
    trace_step: "trc",
    console_error: "err",
    request_failure: "req",
    assertion_mismatch: "ast",
    timing_anomaly: "clk",
    error_message: "msg",
  };

  return (
    <Badge
      size="sm"
      variant="filled"
      color="dark.5"
      fw={700}
      tt="uppercase"
      style={{ fontSize: 10 }}
    >
      {icons[type] ?? "?"}
    </Badge>
  );
}

export function hasEvidenceContent(
  evidence: EvidenceItem[],
  artifacts: Artifact[],
): boolean {
  const items = evidence.filter((e) => e.type !== "error_message");
  const screenshots = artifacts.filter(
    (a) => a.type === "screenshot" && a.contentType.startsWith("image/"),
  );
  const videos = artifacts.filter(
    (a) => a.type === "video" && a.contentType.startsWith("video/"),
  );
  return items.length > 0 || screenshots.length > 0 || videos.length > 0;
}

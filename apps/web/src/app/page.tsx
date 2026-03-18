import { Stack, Title, Text } from "@mantine/core";
import { UploadForm } from "./components/upload-form";

export default function Home() {
  return (
    <Stack align="center" gap="xl" pt="xl">
      <Stack align="center" gap="xs">
        <Title order={1} ta="center">
          Find the first divergence
        </Title>
        <Text size="lg" c="dimmed" ta="center" maw={520}>
          Upload a failing Playwright report and an optional passing report.
          lastGreen aligns matching tests, finds the first meaningful
          divergence, and returns an evidence-backed triage summary.
        </Text>
      </Stack>

      <UploadForm />
    </Stack>
  );
}

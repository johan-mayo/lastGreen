"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Stack, Button, Alert, Text, Group } from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { withBasePath } from "../lib/base-path";

export function UploadForm() {
  const router = useRouter();
  const [failingFile, setFailingFile] = useState<File | null>(null);
  const [passingFile, setPassingFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!failingFile) return;
    setLoading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("failing", failingFile);
      if (passingFile) {
        formData.append("passing", passingFile);
      }

      const res = await fetch(withBasePath("/api/upload"), {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Upload failed" }));
        throw new Error(body.error ?? "Upload failed");
      }

      const { id } = await res.json();
      router.push(`/results/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Stack w="100%" maw={640} gap="md">
      <DropZone
        label="Failing report"
        sublabel="Required — JSON, HTML report, or zipped playwright-report/"
        file={failingFile}
        onFile={setFailingFile}
        required
      />
      <DropZone
        label="Passing report"
        sublabel="Optional — for comparison"
        file={passingFile}
        onFile={setPassingFile}
      />

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      <Button
        onClick={handleSubmit}
        disabled={!failingFile}
        loading={loading}
        color="green"
        size="lg"
        fullWidth
      >
        Analyze
      </Button>
    </Stack>
  );
}

function DropZone({
  label,
  sublabel,
  file,
  onFile,
  required,
}: {
  label: string;
  sublabel: string;
  file: File | null;
  onFile: (f: File | null) => void;
  required?: boolean;
}) {
  const handleDrop = useCallback(
    (files: File[]) => {
      if (files[0]) onFile(files[0]);
    },
    [onFile]
  );

  return (
    <Dropzone
      onDrop={handleDrop}
      accept={[
        "application/json",
        "text/html",
        "application/zip",
        "application/x-zip-compressed",
      ]}
      multiple={false}
      p="xl"
      style={{ cursor: "pointer" }}
    >
      <Stack align="center" gap={4}>
        <Group gap={4}>
          <Text fw={500}>{label}</Text>
          {required && (
            <Text c="red" span>
              *
            </Text>
          )}
        </Group>
        <Text size="sm" c="dimmed">
          {sublabel}
        </Text>

        {file ? (
          <Text size="sm" c="green" mt="xs">
            {file.name}
          </Text>
        ) : (
          <Text size="sm" c="dimmed" mt="xs">
            Drop a file here or click to browse
          </Text>
        )}
      </Stack>
    </Dropzone>
  );
}

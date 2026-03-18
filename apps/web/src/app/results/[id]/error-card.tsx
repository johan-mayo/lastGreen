"use client";

import { Box, Paper, Text } from "@mantine/core";
import { CodeHighlight } from "@mantine/code-highlight";

export function ErrorBlock({
  message,
  stack,
}: {
  message: string;
  stack?: string;
}) {
  const clean = message.replace(/\[\d+m/g, "");
  const cleanStack = stack?.replace(/\[\d+m/g, "") ?? "";

  const lines = clean.split("\n");
  const headline = lines[0] ?? "";
  const messageDetail = lines.slice(1).join("\n").trim();

  const detail =
    cleanStack && cleanStack !== clean ? cleanStack : messageDetail;

  return (
    <Box>
      <Paper
        p="sm"
        radius="sm"
        bg="red.9"
        style={{
          borderBottomLeftRadius: detail ? 0 : undefined,
          borderBottomRightRadius: detail ? 0 : undefined,
        }}
      >
        <Text
          size="sm"
          fw={500}
          c="red.2"
          style={{ wordBreak: "break-word" }}
        >
          {headline}
        </Text>
      </Paper>
      {detail && (
        <CodeHighlight
          code={detail}
          language="javascript"
          withCopyButton={false}
          styles={{
            codeHighlight: {
              borderTopLeftRadius: 0,
              borderTopRightRadius: 0,
              maxHeight: 256,
              overflow: "auto",
              fontSize: "var(--mantine-font-size-xs)",
            },
          }}
        />
      )}
    </Box>
  );
}

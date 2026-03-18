"use client";

import { useState, useMemo } from "react";
import type { NetworkRequest } from "@last-green/core";
import {
  Alert,
  Badge,
  Box,
  Code,
  Collapse,
  Group,
  Paper,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { CodeHighlight } from "@mantine/code-highlight";

const STATUS_FILTERS = [
  { label: "All", value: "all" },
  { label: "4xx", value: "4xx" },
  { label: "5xx", value: "5xx" },
  { label: "3xx", value: "3xx" },
  { label: "ERR", value: "err" },
] as const;

// Known third-party domains that are typically noise in test results
const NOISE_DOMAINS = [
  "segment.io",
  "segment.com",
  "sentry.io",
  "google-analytics.com",
  "googletagmanager.com",
  "googlesyndication.com",
  "googleadservices.com",
  "doubleclick.net",
  "facebook.net",
  "facebook.com",
  "fbcdn.net",
  "hotjar.com",
  "mixpanel.com",
  "amplitude.com",
  "heapanalytics.com",
  "fullstory.com",
  "intercom.io",
  "intercomcdn.com",
  "hubspot.com",
  "hs-analytics.net",
  "clarity.ms",
  "newrelic.com",
  "nr-data.net",
  "datadoghq.com",
  "launchdarkly.com",
  "optimizely.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "use.typekit.net",
  "cdn.jsdelivr.net",
  "cdnjs.cloudflare.com",
  "unpkg.com",
  "pendo.io",
  "stripe.com",
];

const NOISE_RESOURCE_TYPES = new Set(["image", "font", "stylesheet", "media"]);

// ---- Helpers ----

interface RequestGroup {
  key: string;
  method: string;
  displayUrl: string;
  status: number;
  statusText: string;
  requests: NetworkRequest[];
  avgDuration: number;
  isNoise: boolean;
}

function getHostname(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function getOriginPathname(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch { return url; }
}

function isNoiseDomain(hostname: string): boolean {
  return NOISE_DOMAINS.some(
    (d) => hostname === d || hostname.endsWith("." + d),
  );
}

function classifyNoise(r: NetworkRequest): boolean {
  if (isNoiseDomain(getHostname(r.url))) return true;
  if (r.resourceType && NOISE_RESOURCE_TYPES.has(r.resourceType)) return true;
  return false;
}

// ---- Components ----

export function NetworkRequestsPanel({
  requests,
  attemptLabel,
}: {
  requests: NetworkRequest[];
  attemptLabel?: number;
}) {
  const [urlFilter, setUrlFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [noiseExpanded, setNoiseExpanded] = useState(false);

  // Filter by status + URL text
  const filtered = useMemo(() => {
    return requests.filter((r) => {
      if (urlFilter && !r.url.toLowerCase().includes(urlFilter.toLowerCase()))
        return false;
      if (statusFilter === "4xx" && (r.status < 400 || r.status >= 500))
        return false;
      if (statusFilter === "5xx" && r.status < 500) return false;
      if (statusFilter === "3xx" && (r.status < 300 || r.status >= 400))
        return false;
      if (statusFilter === "err" && r.status > 0) return false;
      return true;
    });
  }, [requests, urlFilter, statusFilter]);

  // Group by method + origin+pathname + status
  const groups = useMemo(() => {
    const map = new Map<string, RequestGroup>();
    for (const r of filtered) {
      const originPath = getOriginPathname(r.url);
      const key = `${r.method}|${originPath}|${r.status}`;
      const existing = map.get(key);
      if (existing) {
        existing.requests.push(r);
        existing.avgDuration = Math.round(
          existing.requests.reduce((s, req) => s + req.duration, 0) /
            existing.requests.length,
        );
      } else {
        map.set(key, {
          key,
          method: r.method,
          displayUrl: originPath,
          status: r.status,
          statusText: r.statusText,
          requests: [r],
          avgDuration: r.duration,
          isNoise: classifyNoise(r),
        });
      }
    }
    return Array.from(map.values());
  }, [filtered]);

  const relevantGroups = groups.filter((g) => !g.isNoise);
  const noiseGroups = groups.filter((g) => g.isNoise);
  const noiseRequestCount = noiseGroups.reduce(
    (s, g) => s + g.requests.length,
    0,
  );

  const toggle = (key: string) =>
    setExpandedKey(expandedKey === key ? null : key);

  return (
    <Alert
      variant="light"
      color="orange"
      radius="md"
      p="lg"
      title={`Non-2xx network requests${attemptLabel ? ` — attempt ${attemptLabel}` : ""} (${filtered.length}/${requests.length})`}
    >
      {/* Filters */}
      <Group mt="sm" gap="sm" wrap="wrap">
        <TextInput
          placeholder="Filter by URL..."
          value={urlFilter}
          onChange={(e) => setUrlFilter(e.currentTarget.value)}
          size="xs"
          style={{ flex: 1, minWidth: 150, maxWidth: 300 }}
        />
        <SegmentedControl
          size="xs"
          value={statusFilter}
          onChange={setStatusFilter}
          data={STATUS_FILTERS.map((f) => ({ label: f.label, value: f.value }))}
        />
      </Group>

      {/* Scrollable request list */}
      <ScrollArea.Autosize mah={420} mt="sm" offsetScrollbars>
        <Stack gap={4}>
          {/* ---- Likely-relevant section ---- */}
          {relevantGroups.length > 0 && (
            <>
              {noiseGroups.length > 0 && (
                <Text size="xs" fw={700} tt="uppercase" c="dimmed" mt={4}>
                  Likely relevant ({relevantGroups.length}{" "}
                  {relevantGroups.length === 1 ? "group" : "groups"})
                </Text>
              )}
              {relevantGroups.map((g) => (
                <GroupRow
                  key={g.key}
                  group={g}
                  expanded={expandedKey === g.key}
                  onToggle={() => toggle(g.key)}
                />
              ))}
            </>
          )}

          {/* ---- Noise section (collapsed by default) ---- */}
          {noiseGroups.length > 0 && (
            <>
              <UnstyledButton
                onClick={() => setNoiseExpanded(!noiseExpanded)}
                mt="xs"
              >
                <Group gap="xs">
                  <Text size="xs" fw={700} tt="uppercase" c="dimmed">
                    {noiseExpanded ? "▾" : "▸"} Third-party / noise (
                    {noiseRequestCount})
                  </Text>
                  <Text size="xs" c="dimmed">
                    {noiseGroups
                      .slice(0, 3)
                      .map((g) => getHostname(g.requests[0].url))
                      .join(", ")}
                    {noiseGroups.length > 3 && " …"}
                  </Text>
                </Group>
              </UnstyledButton>
              <Collapse in={noiseExpanded}>
                <Stack gap={4}>
                  {noiseGroups.map((g) => (
                    <GroupRow
                      key={g.key}
                      group={g}
                      expanded={expandedKey === g.key}
                      onToggle={() => toggle(g.key)}
                    />
                  ))}
                </Stack>
              </Collapse>
            </>
          )}

          {groups.length === 0 && (
            <Text size="xs" c="dimmed" py="xs">
              No requests match filters.
            </Text>
          )}
        </Stack>
      </ScrollArea.Autosize>

      {/* Footer summary */}
      {groups.length > 0 && (
        <Text size="xs" c="dimmed" mt="xs">
          {groups.length} {groups.length === 1 ? "group" : "groups"} from{" "}
          {filtered.length} requests
          {noiseRequestCount > 0 &&
            !noiseExpanded &&
            ` · ${noiseRequestCount} noise hidden`}
        </Text>
      )}
    </Alert>
  );
}

// ---- Grouped row ----

function GroupRow({
  group,
  expanded,
  onToggle,
}: {
  group: RequestGroup;
  expanded: boolean;
  onToggle: () => void;
}) {
  const representative = group.requests[0];
  const count = group.requests.length;

  return (
    <Paper radius="sm" bg="dark.6" style={{ overflow: "hidden" }}>
      <UnstyledButton onClick={onToggle} w="100%" p="xs">
        <Group justify="space-between" gap="sm" wrap="nowrap">
          <Group
            gap="xs"
            wrap="nowrap"
            style={{ minWidth: 0, overflow: "hidden" }}
          >
            <Code>{group.method}</Code>
            <Text size="xs" ff="monospace" truncate="end">
              {group.displayUrl}
            </Text>
            {count > 1 && (
              <Badge size="xs" variant="filled" color="gray">
                ×{count}
              </Badge>
            )}
          </Group>
          <Group gap="sm" wrap="nowrap" style={{ flexShrink: 0 }}>
            <StatusBadge status={group.status} />
            <Text size="xs" c="dimmed" w={48} ta="right">
              {count > 1 ? `~${group.avgDuration}` : group.avgDuration}ms
            </Text>
            <Text size="xs" c="dimmed">
              {expanded ? "▲" : "▼"}
            </Text>
          </Group>
        </Group>
      </UnstyledButton>

      <Collapse in={expanded}>
        <Box
          p="sm"
          style={{ borderTop: "1px solid var(--mantine-color-dark-4)" }}
        >
          <RequestDetail request={representative} />
          {count > 1 && (
            <Text size="xs" c="dimmed" mt="sm" fs="italic">
              +{count - 1} similar request{count - 1 > 1 ? "s" : ""} (same
              endpoint &amp; status)
            </Text>
          )}
        </Box>
      </Collapse>
    </Paper>
  );
}

// ---- Expanded detail for one request ----

function RequestDetail({ request: r }: { request: NetworkRequest }) {
  return (
    <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
      {/* Request side */}
      <Box>
        <Text size="xs" fw={600} tt="uppercase" c="dimmed" mb="xs">
          Request
        </Text>
        {r.requestContentType && (
          <Text size="xs" c="dimmed" mb={4}>
            Content-Type: {r.requestContentType}
          </Text>
        )}
        {r.requestHeaders && r.requestHeaders.length > 0 && (
          <details style={{ marginBottom: 8 }}>
            <summary
              style={{
                cursor: "pointer",
                fontSize: "var(--mantine-font-size-xs)",
                color: "var(--mantine-color-dimmed)",
              }}
            >
              Headers ({r.requestHeaders.length})
            </summary>
            <Code
              block
              mt={4}
              style={{
                maxHeight: 160,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {r.requestHeaders.map((h) => `${h.name}: ${h.value}`).join("\n")}
            </Code>
          </details>
        )}
        {r.requestBody ? (
          <Box>
            <Text size="xs" c="dimmed" mb={4}>
              Body:
            </Text>
            <CodeHighlight
              code={formatBody(r.requestBody, r.requestContentType)}
              language={detectLanguage(r.requestContentType, r.requestBody)}
              withCopyButton={false}
              styles={{
                codeHighlight: {
                  maxHeight: 192,
                  overflow: "auto",
                  fontSize: "var(--mantine-font-size-xs)",
                },
              }}
            />
          </Box>
        ) : (
          <Text size="xs" c="dimmed" fs="italic">
            No request body
          </Text>
        )}
      </Box>

      {/* Response side */}
      <Box>
        <Text size="xs" fw={600} tt="uppercase" c="dimmed" mb="xs">
          Response — {r.status <= 0 ? "Failed" : r.status} {r.statusText}
        </Text>
        {r.responseContentType && (
          <Text size="xs" c="dimmed" mb={4}>
            Content-Type: {r.responseContentType}
          </Text>
        )}
        {r.responseHeaders && r.responseHeaders.length > 0 && (
          <details style={{ marginBottom: 8 }}>
            <summary
              style={{
                cursor: "pointer",
                fontSize: "var(--mantine-font-size-xs)",
                color: "var(--mantine-color-dimmed)",
              }}
            >
              Headers ({r.responseHeaders.length})
            </summary>
            <Code
              block
              mt={4}
              style={{
                maxHeight: 160,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {r.responseHeaders
                .map((h) => `${h.name}: ${h.value}`)
                .join("\n")}
            </Code>
          </details>
        )}
        {r.responseBody ? (
          <Box>
            <Text size="xs" c="dimmed" mb={4}>
              Body:
            </Text>
            <CodeHighlight
              code={formatBody(r.responseBody, r.responseContentType)}
              language={detectLanguage(r.responseContentType, r.responseBody)}
              withCopyButton={false}
              styles={{
                codeHighlight: {
                  maxHeight: 192,
                  overflow: "auto",
                  fontSize: "var(--mantine-font-size-xs)",
                },
              }}
            />
          </Box>
        ) : (
          <Text size="xs" c="dimmed" fs="italic">
            No response body
          </Text>
        )}
      </Box>
    </SimpleGrid>
  );
}

// ---- Shared utilities ----

export function StatusBadge({ status }: { status: number }) {
  const color =
    status >= 500
      ? "red"
      : status >= 400
        ? "orange"
        : status >= 300
          ? "yellow"
          : status <= 0
            ? "red"
            : "gray";
  return (
    <Badge size="sm" variant="light" color={color} fw={700}>
      {status <= 0 ? "ERR" : status}
    </Badge>
  );
}

function detectLanguage(contentType?: string, body?: string): string {
  if (contentType?.includes("json")) return "json";
  if (contentType?.includes("html")) return "html";
  if (contentType?.includes("xml")) return "xml";
  if (contentType?.includes("css")) return "css";
  if (contentType?.includes("javascript")) return "javascript";
  if (
    body &&
    (body.trimStart().startsWith("{") || body.trimStart().startsWith("["))
  )
    return "json";
  if (body && body.trimStart().startsWith("<")) return "html";
  return "text";
}

export function formatBody(body: string, contentType?: string): string {
  if (
    contentType?.includes("json") ||
    body.startsWith("{") ||
    body.startsWith("[")
  ) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      /* not valid JSON */
    }
  }
  return body;
}

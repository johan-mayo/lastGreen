import { NextRequest, NextResponse } from "next/server";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

const UPLOAD_DIR = process.env.LASTGREEN_DATA_DIR || join(process.cwd(), ".lastgreen-data");

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Validate session ID format
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  // Get the artifact path from the query string
  const artifactPath = req.nextUrl.searchParams.get("path");
  if (!artifactPath) {
    return NextResponse.json({ error: "Missing path parameter" }, { status: 400 });
  }

  // Prevent path traversal
  const normalized = artifactPath.replace(/\.\./g, "").replace(/\/\//g, "/");
  const sessionDir = join(UPLOAD_DIR, id);
  const fullPath = join(sessionDir, normalized);

  // Ensure the resolved path is within the session directory
  if (!fullPath.startsWith(sessionDir)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  // Try serving from local filesystem first
  try {
    await stat(fullPath);
    const data = await readFile(fullPath);
    const ext = fullPath.slice(fullPath.lastIndexOf(".")).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    return new NextResponse(data, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    // File not found locally — try proxy from source
  }

  // Check if we have artifact source URLs (from aegis integration)
  try {
    const sourcesPath = join(sessionDir, "artifact-sources.json");
    const sourcesRaw = await readFile(sourcesPath, "utf-8");
    const sources = JSON.parse(sourcesRaw) as {
      failingArtifactBaseUrl?: string | null;
      passingArtifactBaseUrl?: string | null;
    };

    // Try each source URL
    const baseUrls = [
      sources.failingArtifactBaseUrl,
      sources.passingArtifactBaseUrl,
    ].filter(Boolean) as string[];

    for (const baseUrl of baseUrls) {
      try {
        const remoteUrl = `${baseUrl}/${normalized}`;
        const resp = await fetch(remoteUrl);
        if (!resp.ok) continue;

        const data = Buffer.from(await resp.arrayBuffer());
        const ext = fullPath.slice(fullPath.lastIndexOf(".")).toLowerCase();
        const contentType = MIME_TYPES[ext] ?? resp.headers.get("content-type") ?? "application/octet-stream";

        // Cache locally for future requests
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, data);

        return new NextResponse(data, {
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=3600",
          },
        });
      } catch {
        // Try next source
      }
    }
  } catch {
    // No artifact sources file — fall through
  }

  return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
}

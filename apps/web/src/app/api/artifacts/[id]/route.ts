import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const UPLOAD_DIR = join(process.cwd(), ".lastgreen-data");

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
  const fullPath = join(UPLOAD_DIR, id, normalized);

  // Ensure the resolved path is within the session directory
  const sessionDir = join(UPLOAD_DIR, id);
  if (!fullPath.startsWith(sessionDir)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

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
    return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
  }
}

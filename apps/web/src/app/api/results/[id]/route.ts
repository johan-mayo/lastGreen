import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const UPLOAD_DIR = join(process.cwd(), ".lastgreen-data");

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Basic input validation
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  try {
    const raw = await readFile(
      join(UPLOAD_DIR, id, "result.json"),
      "utf-8"
    );
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json({ error: "Result not found" }, { status: 404 });
  }
}

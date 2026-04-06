import { NextRequest, NextResponse } from "next/server";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const MEME_DIR = path.resolve(process.cwd(), "../services/sherpa/memes");
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

function safeFileName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return trimmed.replace(/[^a-zA-Z0-9._ -]/g, "_");
}

export async function GET() {
  try {
    await mkdir(MEME_DIR, { recursive: true });
    const files = await readdir(MEME_DIR, { withFileTypes: true });
    const memes = files
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    return NextResponse.json({ ok: true, memes });
  } catch (error: unknown) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unable to read meme folder." },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    await mkdir(MEME_DIR, { recursive: true });

    const form = await req.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "Expected file upload field named 'file'." }, { status: 400 });
    }

    if (file.size <= 0) {
      return NextResponse.json({ ok: false, error: "Uploaded file is empty." }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json({ ok: false, error: "File exceeds 20MB upload limit." }, { status: 413 });
    }

    const fileName = safeFileName(file.name);
    if (!fileName) {
      return NextResponse.json({ ok: false, error: "File name is invalid." }, { status: 400 });
    }

    const uploadPath = path.join(MEME_DIR, fileName);
    const arrayBuffer = await file.arrayBuffer();
    await writeFile(uploadPath, Buffer.from(arrayBuffer));

    return NextResponse.json({ ok: true, fileName });
  } catch (error: unknown) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Upload failed." },
      { status: 500 }
    );
  }
}

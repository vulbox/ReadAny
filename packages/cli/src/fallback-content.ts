/**
 * Register original-file reading for `readany ask` when a book has no vector index.
 * The desktop app registers this provider at startup; the CLI process does not.
 */
import { setFallbackContentProvider } from "@readany/core/ai/fallback-content-service";
import type { FallbackChapter } from "@readany/core/ai/fallback-content-service";
import { getPlatformService } from "@readany/core/services";
import type { Book } from "@readany/core/types";

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

async function readBookBytes(book: Book): Promise<Uint8Array> {
  const platform = getPlatformService();
  const dataDir = await platform.getDataDir();
  const absolutePath = await platform.joinPath(dataDir, book.filePath);
  if (!(await platform.exists(absolutePath))) {
    throw new Error(`Book file was not found: ${book.filePath}`);
  }
  return Uint8Array.from(await platform.readFile(absolutePath));
}

async function extractPdfChapters(bytes: Uint8Array): Promise<FallbackChapter[]> {
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as PdfJsModule;
  const pdf = await pdfjs
    .getDocument({
      data: bytes.slice(),
      useWorkerFetch: false,
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    })
    .promise;

  const chapters: FallbackChapter[] = [];
  const pagesPerChapter = Math.max(1, Math.min(10, Math.ceil(pdf.numPages / 20)));

  try {
    for (let start = 1; start <= pdf.numPages; start += pagesPerChapter) {
      const end = Math.min(start + pagesPerChapter - 1, pdf.numPages);
      const segments: FallbackChapter["segments"] = [];

      for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const textContent = await page.getTextContent();
        const text = textContent.items
          .map((item) => ("str" in item && typeof item.str === "string" ? item.str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (!text) continue;
        segments.push({ text, cfi: `page:${pageNumber}` });
      }

      if (!segments.length) continue;
      chapters.push({
        index: start - 1,
        title: `Pages ${start}-${end}`,
        content: segments.map((segment) => segment.text).join("\n\n"),
        segments,
      });
    }
  } finally {
    await pdf.destroy();
  }

  return chapters;
}

export function registerCliFallbackContentProvider(): void {
  setFallbackContentProvider({
    async getChapters(book) {
      if (book.format !== "pdf") {
        throw new Error(
          `Original-file reading in readany ask currently supports PDF. This book is ${book.format}.`,
        );
      }
      return extractPdfChapters(await readBookBytes(book));
    },
  });
}

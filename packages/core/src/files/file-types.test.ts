import { describe, expect, it } from "vitest";
import { extensionFor, fileIdFromUrl, fileUrl, isTextFile, mimeTypeFor, safeFileName } from "./file-types";

describe("mimeTypeFor", () => {
  it("maps known extensions, case-insensitively", () => {
    expect(mimeTypeFor("report.PDF")).toBe("application/pdf");
    expect(mimeTypeFor("chart.png")).toBe("image/png");
    expect(mimeTypeFor("data.xlsx")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(mimeTypeFor("archive.tar.gz")).toBe("application/gzip");
  });

  it("falls back to generic binary", () => {
    expect(mimeTypeFor("Makefile")).toBe("application/octet-stream");
    expect(mimeTypeFor(".env")).toBe("application/octet-stream");
    expect(mimeTypeFor("file.")).toBe("application/octet-stream");
    expect(mimeTypeFor("blob.xyz")).toBe("application/octet-stream");
  });
});

describe("extensionFor", () => {
  it("finds an extension for common media types", () => {
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("application/pdf")).toBe("pdf");
    expect(extensionFor("text/plain; charset=utf-8")).toBe("txt");
    expect(extensionFor("application/x-unknown")).toBeNull();
  });
});

describe("safeFileName", () => {
  it("keeps one plain path segment", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\Users\\me\\notes.txt")).toBe("notes.txt");
    expect(safeFileName("my report (final).pdf")).toBe("my_report_final_.pdf");
    expect(safeFileName(".hidden")).toBe("hidden");
    expect(safeFileName("///")).toBe("file");
  });
});

describe("fileIdFromUrl", () => {
  const id = "0b9f6a2e-6c1d-4c47-9a53-2f7d1b8e4c10";

  it("recognizes the app's own file URLs", () => {
    expect(fileIdFromUrl(fileUrl(id))).toBe(id);
    expect(fileIdFromUrl(`/api/files/${id.toUpperCase()}`)).toBe(id);
    expect(fileIdFromUrl(`https://app.example.com/api/files/${id}`, ["https://app.example.com/"])).toBe(id);
  });

  it("refuses other hosts, paths and data URLs", () => {
    expect(fileIdFromUrl(`https://evil.example.com/api/files/${id}`, ["https://app.example.com"])).toBeNull();
    expect(fileIdFromUrl(`/api/files/${id}/../secret`)).toBeNull();
    expect(fileIdFromUrl(`/api/tasks/attachments/${id}`)).toBeNull();
    expect(fileIdFromUrl("/api/files/not-an-id")).toBeNull();
    expect(fileIdFromUrl("data:text/plain;base64,aGVsbG8=")).toBeNull();
    expect(fileIdFromUrl("not a url")).toBeNull();
  });
});

describe("isTextFile", () => {
  it("accepts text, data and source files", () => {
    expect(isTextFile("text/plain", "notes.txt")).toBe(true);
    expect(isTextFile("text/csv; charset=utf-8", "data.csv")).toBe(true);
    expect(isTextFile("application/json", "a.json")).toBe(true);
    expect(isTextFile("application/ld+json", "a.jsonld")).toBe(true);
    expect(isTextFile("application/octet-stream", "README.md")).toBe(true);
    expect(isTextFile("application/octet-stream", "script.py")).toBe(true);
  });

  it("refuses binaries, including SVG images", () => {
    expect(isTextFile("application/pdf", "a.pdf")).toBe(false);
    expect(isTextFile("image/png", "a.png")).toBe(false);
    expect(isTextFile("image/svg+xml", "logo.svg")).toBe(false);
    expect(isTextFile("application/octet-stream", "archive.zip")).toBe(false);
  });
});

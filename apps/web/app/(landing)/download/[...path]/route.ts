const OSS_BASE = "https://lumist-fde-report.oss-cn-shanghai.aliyuncs.com/downloads";

interface DownloadFile {
  source: string;
  contentType: string;
  fileName?: string;
}

const FILES: Record<string, DownloadFile> = {
  "0.0.0-g0e6488d/multica-desktop-0.0.0-g0e6488d-mac-arm64.dmg": {
    source: `${OSS_BASE}/0.0.0-g0e6488d/multica-desktop-0.0.0-g0e6488d-mac-arm64.dmg`,
    contentType: "application/x-apple-diskimage",
    fileName: "multica-desktop-0.0.0-g0e6488d-mac-arm64.dmg",
  },
  "0.0.0-g0e6488d/multica-desktop-0.0.0-g0e6488d-mac-arm64.zip": {
    source: `${OSS_BASE}/0.0.0-g0e6488d/multica-desktop-0.0.0-g0e6488d-mac-arm64.zip`,
    contentType: "application/zip",
    fileName: "multica-desktop-0.0.0-g0e6488d-mac-arm64.zip",
  },
  "0.1.0/multica-mobile-0.1.0.ipa": {
    source: `${OSS_BASE}/0.1.0/multica-mobile-0.1.0.ipa`,
    contentType: "application/octet-stream",
    fileName: "multica-mobile-0.1.0.ipa",
  },
  "0.1.0/manifest.plist": {
    source: `${OSS_BASE}/0.1.0/manifest.plist`,
    contentType: "application/plist+xml",
  },
};

async function serveDownload(
  path: string[],
  headOnly: boolean,
): Promise<Response> {
  const file = FILES[path.join("/")];
  if (!file) return new Response("Not found", { status: 404 });

  const upstream = await fetch(file.source, {
    method: headOnly ? "HEAD" : "GET",
    cache: "no-store",
  });
  if (!upstream.ok) {
    return new Response("Download unavailable", { status: 502 });
  }

  const headers = new Headers({
    "Content-Type": file.contentType,
    "Cache-Control": "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) headers.set("Content-Length", contentLength);
  if (file.fileName) {
    headers.set("Content-Disposition", `attachment; filename="${file.fileName}"`);
  }
  return new Response(headOnly ? null : upstream.body, { status: 200, headers });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return serveDownload((await params).path, false);
}

export async function HEAD(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return serveDownload((await params).path, true);
}

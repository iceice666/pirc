#!/usr/bin/env node
import { requireTestBrowserExecutable } from './test_browser.mjs';

// Capture browser-selected responsive image sources and intrinsic dimensions
// with real Chrome. The generated fixture is checked in separately so other
// parity probes can compare their image selection to this browser oracle.

import { createServer } from "node:http";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "../../../gateway/node_modules/playwright-core/index.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../../..");
const outputPath = path.join(repoRoot, "fixtures/mobile-parity/html-responsive-images.json");
const chromePath = requireTestBrowserExecutable(process.env.CHROME_PATH);
const baselineCommit = "bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c";

const assetSpecs = [
  { path: "/fallback.png", width: 120, color: "#7f6df2" },
  { path: "/density-1x.png", width: 100, color: "#e45d5d" },
  { path: "/density-2x.png", width: 200, color: "#e59a39" },
  { path: "/density-3x.png", width: 300, color: "#4b9f70" },
  { path: "/width-400.png", width: 400, color: "#3988c7" },
  { path: "/width-800.png", width: 800, color: "#8c58b5" },
  { path: "/width-1200.png", width: 1200, color: "#637c38" },
  { path: "/picture-mobile.png", width: 320, color: "#d36c9b" },
  { path: "/picture-desktop.png", width: 800, color: "#3b9c9c" },
  { path: "/type-png.png", width: 240, color: "#d4a52f" },
];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function makePng(width, height, color) {
  const rgb = color.match(/[0-9a-f]{2}/gi).map((component) => Number.parseInt(component, 16));
  const stride = width * 4 + 1;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * stride;
    pixels[rowOffset] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixelOffset = rowOffset + 1 + x * 4;
      pixels[pixelOffset] = rgb[0];
      pixels[pixelOffset + 1] = rgb[1];
      pixels[pixelOffset + 2] = rgb[2];
      pixels[pixelOffset + 3] = 255;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0; // compression
  header[11] = 0; // filter
  header[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const assets = new Map(
  assetSpecs.map((spec) => {
    const height = spec.width / 2;
    const bytes = makePng(spec.width, height, spec.color);
    return [
      spec.path,
      {
        ...spec,
        height,
        mimeType: "image/png",
        bytes,
        metadata: {
          path: spec.path,
          pixelWidth: spec.width,
          pixelHeight: height,
          mimeType: "image/png",
          byteLength: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          color: spec.color,
          dataUri: `data:image/png;base64,${bytes.toString("base64")}`,
        },
      },
    ];
  }),
);

const cases = [];

function imageMarkup(attrs) {
  return `<img id="probe" style="display:block;width:160px;height:auto" ${attrs}>`;
}

function addCase({ id, title, body, viewportWidth = 390, deviceScaleFactor = 1 }) {
  cases.push({
    id,
    title,
    viewport: { width: viewportWidth, height: 800 },
    deviceScaleFactor,
    html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0">${body}</body></html>`,
  });
}

const densityMarkup = imageMarkup(
  'alt="density fixture" srcset="/density-1x.png 1x, /density-2x.png 2x"',
);
addCase({ id: "density-no-src-dpr1", title: "1x and 2x candidates without src at DPR 1", body: densityMarkup });
addCase({ id: "density-no-src-dpr2", title: "1x and 2x candidates without src at DPR 2", body: densityMarkup, deviceScaleFactor: 2 });
addCase({ id: "density-no-src-dpr3", title: "1x and 2x candidates without src at DPR 3", body: densityMarkup, deviceScaleFactor: 3 });
addCase({
  id: "src-fallback-without-1x-dpr1",
  title: "src fallback alongside a 2x-only srcset at DPR 1",
  body: imageMarkup('alt="fallback fixture" src="/fallback.png" srcset="/density-2x.png 2x"'),
});
addCase({
  id: "src-fallback-without-1x-dpr2",
  title: "2x srcset candidate alongside src fallback at DPR 2",
  body: imageMarkup('alt="fallback fixture" src="/fallback.png" srcset="/density-2x.png 2x"'),
  deviceScaleFactor: 2,
});

const widthMarkup = imageMarkup(
  'alt="width fixture" src="/fallback.png" srcset="/width-400.png 400w, /width-800.png 800w, /width-1200.png 1200w"',
);
addCase({
  id: "width-srcset-fixed-200-dpr1",
  title: "400w, 800w, and 1200w candidates with sizes=200px at DPR 1",
  body: widthMarkup.replace('srcset="', 'sizes="200px" srcset="'),
});
addCase({
  id: "width-srcset-fixed-200-dpr2",
  title: "400w, 800w, and 1200w candidates with sizes=200px at DPR 2",
  body: widthMarkup.replace('srcset="', 'sizes="200px" srcset="'),
  deviceScaleFactor: 2,
});
addCase({
  id: "width-srcset-50vw-390-dpr1",
  title: "50vw source size at a 390px viewport and DPR 1",
  body: widthMarkup.replace('srcset="', 'sizes="50vw" srcset="'),
});
addCase({
  id: "width-srcset-50vw-390-dpr2",
  title: "50vw source size at a 390px viewport and DPR 2",
  body: widthMarkup.replace('srcset="', 'sizes="50vw" srcset="'),
  deviceScaleFactor: 2,
});
addCase({
  id: "width-srcset-50vw-1024-dpr1",
  title: "50vw source size at a 1024px viewport and DPR 1",
  body: widthMarkup.replace('srcset="', 'sizes="50vw" srcset="'),
  viewportWidth: 1024,
});
addCase({
  id: "width-srcset-media-sizes-390-dpr1",
  title: "Media-conditioned sizes fallback below 700px at DPR 1",
  body: widthMarkup.replace('srcset="', 'sizes="(min-width: 700px) 50vw, 100vw" srcset="'),
});
addCase({
  id: "width-srcset-media-sizes-768-dpr2",
  title: "Media-conditioned 50vw source size at 768px and DPR 2",
  body: widthMarkup.replace('srcset="', 'sizes="(min-width: 700px) 50vw, 100vw" srcset="'),
  viewportWidth: 768,
  deviceScaleFactor: 2,
});
addCase({
  id: "width-srcset-min-function-media-1024-dpr2",
  title: "min() inside a matching media-conditioned sizes value",
  body: widthMarkup.replace('srcset="', 'sizes="(min-width: 700px) min(50vw, 360px), 100vw" srcset="'),
  viewportWidth: 1024,
  deviceScaleFactor: 2,
});
addCase({
  id: "width-srcset-default-sizes-dpr2",
  title: "Width descriptors with the default 100vw source size at DPR 2",
  body: widthMarkup,
  deviceScaleFactor: 2,
});
addCase({
  id: "width-srcset-50vw-1024-dpr2",
  title: "50vw source size at a 1024px viewport and DPR 2",
  body: widthMarkup.replace('srcset="', 'sizes="50vw" srcset="'),
  viewportWidth: 1024,
  deviceScaleFactor: 2,
});

const pictureMarkup = `<picture><source media="(max-width: 600px)" srcset="/picture-mobile.png"><source media="(min-width: 601px)" srcset="/picture-desktop.png">${imageMarkup('alt="picture media fixture" src="/fallback.png"')}</picture>`;
addCase({ id: "picture-media-mobile-390", title: "picture source selected by max-width media", body: pictureMarkup });
addCase({
  id: "picture-media-desktop-768",
  title: "picture source selected by min-width media",
  body: pictureMarkup,
  viewportWidth: 768,
});
addCase({
  id: "picture-source-sizes-768-dpr2",
  title: "picture source media and sizes affect width-candidate selection",
  body: `<picture><source media="(min-width: 700px)" srcset="/width-400.png 400w, /width-800.png 800w" sizes="(min-width: 1000px) 50vw, 75vw">${imageMarkup('alt="picture sizes fixture" src="/fallback.png"')}</picture>`,
  viewportWidth: 768,
  deviceScaleFactor: 2,
});
addCase({
  id: "picture-unsupported-type-skipped",
  title: "unsupported picture MIME source skipped in favor of supported PNG",
  body: `<picture><source type="image/not-real" srcset="/density-2x.png"><source type="image/png" srcset="/type-png.png">${imageMarkup('alt="picture type fixture" src="/fallback.png"')}</picture>`,
  deviceScaleFactor: 2,
});

const dataAsset = assets.get("/density-1x.png");
const dataUri = `data:image/png;base64,${dataAsset.bytes.toString("base64")}`;
const dataUriMarkup = imageMarkup(
  `alt="data URI fixture" src="/fallback.png" srcset="${dataUri} 1x, /density-2x.png 2x"`,
);
addCase({ id: "srcset-data-uri-comma-dpr1", title: "data URI candidate with an embedded comma selected at DPR 1", body: dataUriMarkup });
addCase({
  id: "srcset-data-uri-comma-dpr2",
  title: "network candidate selected beside data URI candidate at DPR 2",
  body: dataUriMarkup,
  deviceScaleFactor: 2,
});

addCase({
  id: "srcset-invalid-mixed-descriptor",
  title: "mixed width and density descriptors are ignored while valid candidates remain",
  body: imageMarkup('alt="invalid descriptor fixture" src="/fallback.png" srcset="/width-400.png 400w 2x, /width-800.png 800w" sizes="200px"'),
});

const serverRequests = [];
const server = createServer((request, response) => {
  const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  serverRequests.push(requestPath);
  const caseMatch = /^\/fixture\/([a-z0-9-]+)$/.exec(requestPath);
  if (caseMatch) {
    const fixture = cases.find((item) => item.id === caseMatch[1]);
    if (!fixture) {
      response.writeHead(404).end("unknown fixture");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(fixture.html);
    return;
  }

  const asset = assets.get(requestPath);
  if (asset) {
    response.writeHead(200, {
      "content-type": asset.mimeType,
      "content-length": asset.bytes.length,
      "cache-control": "public, max-age=3600",
    });
    response.end(asset.bytes);
    return;
  }

  response.writeHead(404).end("not found");
});

function currentSrcValue(browserCurrentSrc, origin) {
  if (browserCurrentSrc.startsWith("data:")) return browserCurrentSrc;
  const url = new URL(browserCurrentSrc);
  if (url.origin !== origin) throw new Error(`Image unexpectedly loaded from ${url.origin}`);
  return `${url.pathname}${url.search}`;
}

function assetForCurrentSrc(currentSrc) {
  if (currentSrc.startsWith("data:")) {
    const match = /^data:([^;,]+);base64,(.*)$/.exec(currentSrc);
    if (!match) return { kind: "data", mimeType: currentSrc.slice(5).split(/[;,]/, 1)[0] };
    const bytes = Buffer.from(match[2], "base64");
    return {
      kind: "data",
      mimeType: match[1],
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      pixelWidth: dataAsset.width,
      pixelHeight: dataAsset.height,
      dataUri: currentSrc,
    };
  }
  const asset = assets.get(currentSrc.split("?", 1)[0]);
  return asset ? { kind: "http", ...asset.metadata } : { kind: "http", path: currentSrc };
}

async function run() {
  let browser;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const browserVersion = browser.version();
    const captured = [];
    for (const fixture of cases) {
      const context = await browser.newContext({
        viewport: fixture.viewport,
        deviceScaleFactor: fixture.deviceScaleFactor,
      });
      const page = await context.newPage();
      const imageRequests = [];
      const pageErrors = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.origin === origin && url.pathname.endsWith(".png")) imageRequests.push(url.pathname);
      });
      page.on("pageerror", (error) => pageErrors.push(error.message));

      try {
        await page.goto(`${origin}/fixture/${fixture.id}`, { waitUntil: "load" });
        const measured = await page.evaluate(async () => {
          const image = document.querySelector("#probe");
          await image.decode();
          const rect = image.getBoundingClientRect();
          return {
            currentSrc: image.currentSrc,
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
            complete: image.complete,
            cssRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          };
        });
        if (!measured.complete || measured.naturalWidth <= 0 || measured.naturalHeight <= 0) {
          throw new Error(`${fixture.id}: Chrome did not decode a non-empty image`);
        }
        if (pageErrors.length > 0) throw new Error(`${fixture.id}: ${pageErrors.join("; ")}`);
        const currentSrc = currentSrcValue(measured.currentSrc, origin);
        const result = {
          id: fixture.id,
          title: fixture.title,
          authoredHtml: fixture.html,
          viewport: fixture.viewport,
          deviceScaleFactor: fixture.deviceScaleFactor,
          expectedCurrentSrc: currentSrc,
          expectedNaturalWidth: measured.naturalWidth,
          expectedNaturalHeight: measured.naturalHeight,
          expectedCssRect: measured.cssRect,
          expectedSourceAsset: assetForCurrentSrc(currentSrc),
          capture: {
            browserCurrentSrc: measured.currentSrc,
            imageRequests: [...new Set(imageRequests)],
            complete: measured.complete,
            pageErrors,
          },
        };
        captured.push(result);
      } finally {
        await context.close();
      }
    }

    const document = {
      schemaVersion: 1,
      description: "Chrome oracle for responsive HTML image source selection and intrinsic dimensions.",
      captureNotes: [
        "The unsupported-type picture case uses image/not-real because Chrome 155 supports AVIF.",
        "Each case gets a fresh browser context to avoid cross-case image cache effects.",
      ],
      baselineCommit,
      browser: {
        name: "Google Chrome",
        version: browserVersion,
        executablePath: chromePath,
        userAgent: await (async () => {
          const page = await browser.newPage();
          try {
            return await page.evaluate(() => navigator.userAgent);
          } finally {
            await page.close();
          }
        })(),
      },
      viewportHeight: 800,
      assetManifest: [...assets.values()].map((asset) => asset.metadata),
      fixtures: captured,
      serverRequests: [...new Set(serverRequests)],
    };
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`);
    process.stdout.write(`Captured ${captured.length} responsive image cases to ${outputPath}\n`);
  } finally {
    if (browser) await browser.close();
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }
}

await run();

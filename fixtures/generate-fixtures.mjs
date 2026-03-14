/**
 * Generate HTML and ZIP fixture files from the existing JSON fixtures.
 * Run: node fixtures/generate-fixtures.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import JSZip from "jszip";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function generateHtmlReport(jsonPath, outputPath) {
  const json = await readFile(jsonPath, "utf-8");

  // Create inner ZIP with report.json (mimics Playwright's embedded data)
  const innerZip = new JSZip();
  innerZip.file("report.json", json);
  const innerBuffer = await innerZip.generateAsync({ type: "nodebuffer" });
  const base64 = innerBuffer.toString("base64");

  // Mimic a real Playwright HTML report structure
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Playwright Test Report</title>
<style>
  body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 2rem; }
  h1 { color: #00d4aa; }
  .info { color: #888; font-size: 0.9rem; }
</style>
</head>
<body>
<h1>Playwright Test Report</h1>
<p class="info">This is a fixture HTML report for lastGreen testing.</p>
<p class="info">The real Playwright HTML report is a full React SPA. This fixture contains the same embedded data format.</p>
<script>
window.playwrightReportBase64 = "${base64}";
</script>
</body>
</html>`;

  await writeFile(outputPath, html);
  console.log(`Generated: ${outputPath} (${Math.round(html.length / 1024)}KB)`);
}

async function generateZipReport(jsonPath, outputPath) {
  const json = await readFile(jsonPath, "utf-8");

  // Create inner ZIP for the embedded data
  const innerZip = new JSZip();
  innerZip.file("report.json", json);
  const innerBuffer = await innerZip.generateAsync({ type: "nodebuffer" });
  const base64 = innerBuffer.toString("base64");

  // Build the HTML with embedded data
  const html = `<!DOCTYPE html>
<html lang="en">
<head><title>Playwright Test Report</title></head>
<body>
<script>window.playwrightReportBase64 = "${base64}";</script>
</body>
</html>`;

  // Create outer ZIP mimicking a downloaded playwright-report/ artifact
  const outerZip = new JSZip();
  const reportDir = outerZip.folder("playwright-report");
  reportDir.file("index.html", html);

  // Add some fake attachment files to make it realistic
  reportDir.folder("data");
  reportDir.file(
    "data/a1b2c3d4e5f6.png",
    Buffer.from("fake-screenshot-data")
  );
  reportDir.file(
    "data/f7e8d9c0b1a2.webm",
    Buffer.from("fake-video-data")
  );

  // Add trace viewer stub
  const traceDir = reportDir.folder("trace");
  traceDir.file("index.html", "<html><body>Trace Viewer</body></html>");

  const outerBuffer = await outerZip.generateAsync({ type: "nodebuffer" });
  await writeFile(outputPath, outerBuffer);
  console.log(`Generated: ${outputPath} (${Math.round(outerBuffer.length / 1024)}KB)`);
}

async function generateJsonInZip(jsonPath, outputPath) {
  const json = await readFile(jsonPath, "utf-8");

  // Simple case: just a report.json inside a zip
  const zip = new JSZip();
  zip.file("report.json", json);

  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(outputPath, buffer);
  console.log(`Generated: ${outputPath} (${Math.round(buffer.length / 1024)}KB)`);
}

async function main() {
  const failingJson = join(__dirname, "failing-report.json");
  const passingJson = join(__dirname, "passing-report.json");

  // HTML reports
  await generateHtmlReport(failingJson, join(__dirname, "failing-report.html"));
  await generateHtmlReport(passingJson, join(__dirname, "passing-report.html"));

  // Zipped playwright-report/ directories (the CI artifact download)
  await generateZipReport(failingJson, join(__dirname, "failing-playwright-report.zip"));
  await generateZipReport(passingJson, join(__dirname, "passing-playwright-report.zip"));

  // Zipped JSON reports (someone zipped the json directly)
  await generateJsonInZip(failingJson, join(__dirname, "failing-report-json.zip"));
  await generateJsonInZip(passingJson, join(__dirname, "passing-report-json.zip"));

  console.log("\nAll fixtures generated. Test combinations:");
  console.log("  1. failing-report.html  + passing-report.html");
  console.log("  2. failing-playwright-report.zip + passing-playwright-report.zip");
  console.log("  3. failing-report-json.zip + passing-report-json.zip");
  console.log("  4. Mix and match: failing-report.html + passing-report.json");
}

main().catch(console.error);

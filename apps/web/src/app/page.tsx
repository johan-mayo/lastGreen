import { UploadForm } from "./components/upload-form";

export default function Home() {
  return (
    <div className="flex flex-col items-center gap-12 pt-16">
      <div className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">
          Find the first divergence
        </h1>
        <p className="mt-4 max-w-lg text-lg text-zinc-400">
          Upload a failing Playwright report and an optional passing report.
          lastGreen aligns matching tests, finds the first meaningful
          divergence, and returns an evidence-backed triage summary.
        </p>
      </div>

      <UploadForm />
    </div>
  );
}

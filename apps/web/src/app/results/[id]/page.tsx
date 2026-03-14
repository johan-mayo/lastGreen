import { ResultsView } from "./results-view";

export default async function ResultsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return <ResultsView id={id} />;
}

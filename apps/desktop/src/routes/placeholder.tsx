import { PageHeader } from "@/components/page-header";

/**
 * Route stub for capabilities that land in later tasks.
 *
 * Explicitly labelled so the shell never looks broken while the feature behind
 * it is still being built.
 */
export function PlaceholderPage({
  title,
  description,
  plannedIn,
}: {
  title: string;
  description: string;
  plannedIn: string;
}) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <div className="p-6">
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">
            Not implemented yet — arrives in {plannedIn}.
          </p>
        </div>
      </div>
    </>
  );
}

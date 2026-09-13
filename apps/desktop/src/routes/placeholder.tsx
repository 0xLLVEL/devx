import { EmptyState } from "@/components/ui/empty-state";

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
    <div className="p-6">
      <EmptyState
        title={title}
        description={`${description} Not implemented yet — arrives in ${plannedIn}.`}
      />
    </div>
  );
}

import { ProjectList } from "@/features/projects/project-list";
import { api } from "@/trpc/server";

export default async function ProjectsPage() {
  // Server component -> gateway block -> NATS -> projects service. Same path as the browser.
  const { items } = await api.project.list({ limit: 20, includeArchived: false });
  return <ProjectList initialItems={items} />;
}

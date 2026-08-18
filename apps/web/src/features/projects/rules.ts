/**
 * SOT: project-rules, slug-rules, client-mirror-projects
 * Pure rules shared by the form that suggests a slug and the contract that validates one.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

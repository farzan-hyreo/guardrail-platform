/**
 * SOT: cn, class-merge, shadcn-utils
 * The shadcn class merger. Every component takes className and merges it here, so a caller
 * can override without fighting specificity.
 */
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

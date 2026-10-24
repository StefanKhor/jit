import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Join class names, then resolve Tailwind conflicts so a caller can always
 * override a component's default utilities with its own (last one wins).
 */
export function cx(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export type CompareAtRule = "any" | "off";

export function compareAtExcluded(
  variant: { price: string; compareAtPrice: string | null },
  rule: CompareAtRule = "any",
) {
  if (variant.compareAtPrice == null || variant.compareAtPrice.trim() === "") return false;
  return rule === "any";
}

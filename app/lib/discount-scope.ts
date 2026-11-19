export function scopeReplacement(current: string[], replacements: Map<string, string>) {
  const next = [...new Set(current.map(id => replacements.get(id) ?? id))];
  return {
    add: next.filter(id => !current.includes(id)),
    remove: current.filter(id => !next.includes(id)),
  };
}

export function protectedProductIds(original: string[], comparePriced: Set<string>) {
  return original.filter(id => !comparePriced.has(id));
}

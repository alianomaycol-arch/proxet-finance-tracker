//
// Builds the parent → children tree from the flat list `getCategories`
// returns. Shared by the pages that show categories nested.

export interface CategoryTreeInput {
  id: string;
  parent_id: string | null;
  sort_order?: number | null;
}

export type CategoryTreeNode<T extends CategoryTreeInput> = T & {
  children: CategoryTreeNode<T>[];
};

/** Categories whose parent is missing become roots; siblings are sorted by
 * `sort_order`. */
export function buildCategoryTree<T extends CategoryTreeInput>(
  categories: T[],
): CategoryTreeNode<T>[] {
  const map = new Map<string, CategoryTreeNode<T>>();
  for (const category of categories) {
    map.set(category.id, { ...category, children: [] });
  }

  const roots: CategoryTreeNode<T>[] = [];
  for (const category of categories) {
    const node = map.get(category.id)!;
    const parent = category.parent_id ? map.get(category.parent_id) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const bySortOrder = (a: T, b: T) => (a.sort_order ?? 0) - (b.sort_order ?? 0);
  roots.sort(bySortOrder);
  for (const node of map.values()) {
    node.children.sort(bySortOrder);
  }
  return roots;
}

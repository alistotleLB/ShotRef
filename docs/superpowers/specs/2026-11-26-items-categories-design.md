# Items list grouped by category (short design)

**Why:** big scenes (10 buildings, 8 lamps, cars, furniture) make the flat Items list long and hard to scan.

**What (approved from the mockup):**
- Shot camera and Sun stay at the top, outside any category.
- Objects sit under folding headings by type, in this order: People, Vehicles, Buildings, Street lamps, Furniture, Nature, Shapes, Floor marks, Imported. Empty categories are not shown.
- A heading shows its name and count; click (or Enter/Space) folds it. Folds are remembered per browser (`prefs.olClosed`).
- A folded heading with keyed items shows an orange ◆.
- The heading eye hides or shows the whole category (one undo step).
- Selecting an item whose category is folded opens that category.
- User groups keep their tag on rows; they are not categories. Order inside a category is the order added.
- Rename by double-click finds its row by id, not by position.

**Approaches:** grouping by type (picked) vs. grouping by user groups (would leave most items ungrouped) vs. a sort-only list (no folding, doesn't shorten the list).

**Left to the builder:** exact type → category map (ball goes to Shapes), styling that matches `.addcat`.

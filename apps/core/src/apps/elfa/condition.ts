import { z } from "zod";

// Elfa owns and validates the condition grammar (watch.ts asks it); Auni stores a leaf as Elfa takes it.
const elfaConditionLeafSchema = z.looseObject({ source: z.string().min(1) });
type ElfaConditionLeaf = z.infer<typeof elfaConditionLeafSchema>;

type ElfaConditionGroup =
  | { readonly AND: readonly (ElfaConditionLeaf | ElfaConditionGroup)[] }
  | { readonly OR: readonly (ElfaConditionLeaf | ElfaConditionGroup)[] };

const elfaConditionNodeSchema: z.ZodType<ElfaConditionLeaf | ElfaConditionGroup> = z.lazy(() =>
  z.union([elfaConditionLeafSchema, elfaConditionGroupSchema]),
);

export const elfaConditionGroupSchema: z.ZodType<ElfaConditionGroup> = z.lazy(() =>
  z.union([
    // Loose for the same reason as a leaf: Auni reads the branch array and
    // nothing else, so a sibling key Elfa adds later is stored, not refused.
    z.looseObject({ AND: z.array(elfaConditionNodeSchema).min(1).max(10) }),
    z.looseObject({ OR: z.array(elfaConditionNodeSchema).min(1).max(10) }),
  ]),
);
